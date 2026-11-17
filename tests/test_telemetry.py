import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import telemetry


class TelemetryContractTest(unittest.TestCase):
    def test_otlp_payload_contains_root_and_phase(self):
        state = {
            "trace_id": "a" * 32, "root_span_id": "b" * 16, "started_ns": 1,
            "resource": {"service.name": "test"},
            "spans": [{"trace_id": "a" * 32, "span_id": "c" * 16, "parent_span_id": "b" * 16,
                       "name": "ci.phase.tests", "start_ns": 2, "end_ns": 3, "status": "OK",
                       "attributes": {"ci.phase.name": "tests", "process.exit_code": 0}}],
        }
        payload = telemetry.build_otlp(state, "success", 4)
        spans = payload["resourceSpans"][0]["scopeSpans"][0]["spans"]
        self.assertEqual(2, len(spans))
        self.assertEqual("ci.workflow.run", spans[0]["name"])
        self.assertEqual("ci.phase.tests", spans[1]["name"])

    def test_finish_writes_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict("os.environ", {"TELEMETRY_DIR": temporary}, clear=False):
                telemetry.start()
                self.assertEqual(0, telemetry.run_phase("ok", [sys.executable, "-c", "pass"]))
                self.assertEqual(0, telemetry.finish("success"))
                self.assertIn("Trace ID", Path(temporary, "evidence.md").read_text())
                self.assertIn("resourceSpans", Path(temporary, "traces.otlp.json").read_text())


if __name__ == "__main__":
    unittest.main()
