#!/usr/bin/env python3
"""Gera evidência de telemetria de uma esteira CI e exporta OTLP/HTTP opcionalmente."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


def now_ns() -> int:
    return time.time_ns()


def iso_from_ns(value: int) -> str:
    return datetime.fromtimestamp(value / 1_000_000_000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def output_dir() -> Path:
    return Path(os.environ.get("TELEMETRY_DIR", ".telemetry"))


def state_path() -> Path:
    return output_dir() / "state.json"


def load_state() -> Dict[str, Any]:
    path = state_path()
    if not path.exists():
        raise RuntimeError("telemetria não inicializada; execute o comando start primeiro")
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(state: Dict[str, Any]) -> None:
    output_dir().mkdir(parents=True, exist_ok=True)
    state_path().write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def github_context() -> Dict[str, str]:
    keys = {
        "service.name": "github-actions-telemetry-poc",
        "ci.provider": "github-actions",
        "ci.workflow.name": os.getenv("GITHUB_WORKFLOW", "local-telemetry-poc"),
        "ci.job.name": os.getenv("GITHUB_JOB", "local"),
        "vcs.repository.name": os.getenv("GITHUB_REPOSITORY", "local/telemetry-poc"),
        "vcs.ref.head.revision": os.getenv("GITHUB_SHA", "local"),
        "vcs.ref.head.name": os.getenv("GITHUB_REF_NAME", "local"),
        "github.run.id": os.getenv("GITHUB_RUN_ID", "local"),
        "github.run.attempt": os.getenv("GITHUB_RUN_ATTEMPT", "1"),
        "runner.os": os.getenv("RUNNER_OS", sys.platform),
    }
    return keys


def append_event(event: Dict[str, Any]) -> None:
    path = output_dir() / "events.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True) + "\n")


def start() -> None:
    started = now_ns()
    state = {
        "trace_id": secrets.token_hex(16),
        "root_span_id": secrets.token_hex(8),
        "started_ns": started,
        "resource": github_context(),
        "spans": [],
    }
    save_state(state)
    append_event({
        "timestamp": iso_from_ns(started), "severity": "INFO", "event": "ci.workflow.started",
        "trace_id": state["trace_id"], "attributes": state["resource"],
    })
    print("::notice title=Telemetry::trace_id=%s" % state["trace_id"])


def run_phase(name: str, command: List[str]) -> int:
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise RuntimeError("informe o comando após --")
    state = load_state()
    started = now_ns()
    print("[telemetry] fase=%s comando=%s" % (name, " ".join(command)), flush=True)
    completed = subprocess.run(command, check=False)
    ended = now_ns()
    status = "OK" if completed.returncode == 0 else "ERROR"
    span = {
        "trace_id": state["trace_id"], "span_id": secrets.token_hex(8), "parent_span_id": state["root_span_id"],
        "name": "ci.phase." + name, "start_ns": started, "end_ns": ended, "status": status,
        "attributes": {"ci.phase.name": name, "process.exit_code": completed.returncode},
    }
    state["spans"].append(span)
    save_state(state)
    append_event({
        "timestamp": iso_from_ns(ended), "severity": "INFO" if status == "OK" else "ERROR",
        "event": "ci.phase.finished", "trace_id": state["trace_id"], "span_id": span["span_id"],
        "attributes": {**span["attributes"], "duration_ms": round((ended - started) / 1_000_000, 3)},
    })
    return completed.returncode


def otlp_attributes(values: Dict[str, Any]) -> List[Dict[str, Any]]:
    result = []
    for key, value in values.items():
        if isinstance(value, bool):
            typed = {"boolValue": value}
        elif isinstance(value, int):
            typed = {"intValue": str(value)}
        elif isinstance(value, float):
            typed = {"doubleValue": value}
        else:
            typed = {"stringValue": str(value)}
        result.append({"key": key, "value": typed})
    return result


def build_otlp(state: Dict[str, Any], status: str, ended: int) -> Dict[str, Any]:
    root = {
        "traceId": state["trace_id"], "spanId": state["root_span_id"], "name": "ci.workflow.run",
        "kind": 1, "startTimeUnixNano": str(state["started_ns"]), "endTimeUnixNano": str(ended),
        "status": {"code": 1 if status == "success" else 2, "message": status},
        "attributes": otlp_attributes({"ci.run.status": status}),
    }
    spans = [root]
    for span in state["spans"]:
        spans.append({
            "traceId": span["trace_id"], "spanId": span["span_id"], "parentSpanId": span["parent_span_id"],
            "name": span["name"], "kind": 1, "startTimeUnixNano": str(span["start_ns"]),
            "endTimeUnixNano": str(span["end_ns"]),
            "status": {"code": 1 if span["status"] == "OK" else 2, "message": span["status"]},
            "attributes": otlp_attributes(span["attributes"]),
        })
    return {"resourceSpans": [{"resource": {"attributes": otlp_attributes(state["resource"])}, "scopeSpans": [{"scope": {"name": "github-actions-telemetry-poc", "version": "1.0.0"}, "spans": spans}]}]}


def prometheus(state: Dict[str, Any], ended: int, status: str) -> str:
    total = (ended - state["started_ns"]) / 1_000_000_000
    labels = 'workflow="%s",job="%s",status="%s"' % (
        state["resource"]["ci.workflow.name"].replace('"', "'"), state["resource"]["ci.job.name"].replace('"', "'"), status)
    lines = [
        "# HELP ci_workflow_duration_seconds Total duration of the CI workflow.",
        "# TYPE ci_workflow_duration_seconds gauge",
        "ci_workflow_duration_seconds{%s} %.6f" % (labels, total),
        "# HELP ci_phase_duration_seconds Duration of a CI phase.",
        "# TYPE ci_phase_duration_seconds gauge",
    ]
    for span in state["spans"]:
        duration = (span["end_ns"] - span["start_ns"]) / 1_000_000_000
        lines.append('ci_phase_duration_seconds{phase="%s",status="%s"} %.6f' % (span["attributes"]["ci.phase.name"], span["status"].lower(), duration))
    return "\n".join(lines) + "\n"


def export_otlp(payload: Dict[str, Any]) -> str:
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip()
    if not endpoint:
        return "not-configured"
    headers = {"Content-Type": "application/json"}
    for pair in os.getenv("OTEL_EXPORTER_OTLP_HEADERS", "").split(","):
        if "=" in pair:
            key, value = pair.split("=", 1)
            headers[key.strip()] = value.strip()
    request = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return "exported-http-%s" % response.status
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return "failed: %s" % error


def finish(status: str) -> int:
    state = load_state()
    ended = now_ns()
    payload = build_otlp(state, status, ended)
    directory = output_dir()
    (directory / "traces.otlp.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    (directory / "metrics.prom").write_text(prometheus(state, ended, status), encoding="utf-8")
    export_result = export_otlp(payload)
    append_event({"timestamp": iso_from_ns(ended), "severity": "INFO", "event": "ci.workflow.finished", "trace_id": state["trace_id"], "attributes": {"ci.run.status": status, "otlp.export": export_result}})
    evidence = [
        "# Evidência de telemetria", "", "| Campo | Valor |", "| --- | --- |",
        "| Status | `%s` |" % status, "| Trace ID | `%s` |" % state["trace_id"],
        "| Início (UTC) | %s |" % iso_from_ns(state["started_ns"]), "| Fim (UTC) | %s |" % iso_from_ns(ended),
        "| Fases | %d |" % len(state["spans"]), "| Exportação OTLP | `%s` |" % export_result, "",
        "## Fases", "", "| Fase | Status | Duração (ms) |", "| --- | --- | ---: |",
    ]
    for span in state["spans"]:
        evidence.append("| %s | %s | %.3f |" % (span["attributes"]["ci.phase.name"], span["status"], (span["end_ns"] - span["start_ns"]) / 1_000_000))
    evidence.extend(["", "Arquivos anexos: `traces.otlp.json`, `metrics.prom` e `events.jsonl`."])
    (directory / "evidence.md").write_text("\n".join(evidence) + "\n", encoding="utf-8")
    print("::notice title=Telemetry evidence::%s" % (directory / "evidence.md"))
    required = os.getenv("TELEMETRY_EXPORT_REQUIRED", "false").lower() == "true"
    return 1 if required and export_result.startswith("failed:") else 0


def summary(path: str) -> None:
    target = Path(path)
    evidence = output_dir() / "evidence.md"
    if evidence.exists():
        with target.open("a", encoding="utf-8") as handle:
            handle.write(evidence.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("start")
    run = sub.add_parser("run")
    run.add_argument("--name", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    done = sub.add_parser("finish")
    done.add_argument("--status", choices=("success", "failure"), required=True)
    summary_parser = sub.add_parser("summary")
    summary_parser.add_argument("--github-summary", required=True)
    args = parser.parse_args()
    if args.action == "start": start(); return 0
    if args.action == "run": return run_phase(args.name, args.command)
    if args.action == "finish": return finish(args.status)
    summary(args.github_summary); return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print("telemetry error: %s" % error, file=sys.stderr)
        raise SystemExit(2)
