'use strict';

const { buildSignals, exportSignals } = require('../src/collector');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const now = Date.now();
const runBase = Number(process.env.DEMO_RUN_BASE || Math.floor(now / 1000));
const timestamp = (offset) => new Date(now + offset * 1000).toISOString();

function job(id, name, conclusion, offset) {
  return {
    id, name, conclusion, html_url: `https://github.com/matheusyves/app-poc-telemetria/actions/runs/${id}`,
    started_at: timestamp(offset), completed_at: timestamp(offset + 8), runner_name: 'ubuntu-latest',
    steps: [{ number: 1, name: `Executar ${name}`, conclusion, started_at: timestamp(offset + 1), completed_at: timestamp(offset + 7) }],
  };
}

function scenario(id, conclusion, jobs, offset) {
  return {
    id, name: 'Delivery pipeline', conclusion, run_attempt: 1, event: 'workflow_dispatch',
    repository: { full_name: 'matheusyves/app-poc-telemetria' }, head_sha: `demo-${id}`, head_branch: 'main',
    run_started_at: timestamp(offset), updated_at: timestamp(offset + 40),
    html_url: `https://github.com/matheusyves/app-poc-telemetria/actions/runs/${id}`,
    jobs,
  };
}

function workflowJob(runId, ordinal, name, conclusion, offset) {
  return job(runId * 10 + ordinal, name, conclusion, offset);
}

function fullRun(runId, conclusion, offset, failingTask = '') {
  return scenario(runId, conclusion, [
    workflowJob(runId, 1, 'quality', failingTask === 'quality' ? 'failure' : 'success', offset),
    ...(failingTask === 'quality' ? [] : [
      workflowJob(runId, 2, 'build-android', failingTask === 'build-android' ? 'failure' : 'success', offset + 10),
      workflowJob(runId, 3, 'security', failingTask === 'security' ? 'failure' : 'success', offset + 20),
      ...(failingTask === 'build-android' || failingTask === 'security' ? [] : [workflowJob(runId, 4, 'deploy', failingTask === 'deploy' ? 'failure' : 'success', offset + 30)]),
    ]),
  ], offset);
}

const runs = [
  fullRun(runBase + 1, 'success', -600),
  fullRun(runBase + 2, 'failure', -540, 'quality'),
  fullRun(runBase + 3, 'failure', -480, 'build-android'),
  fullRun(runBase + 4, 'failure', -420, 'security'),
  fullRun(runBase + 5, 'failure', -360, 'deploy'),
  fullRun(runBase + 6, 'success', -300),
  fullRun(runBase + 7, 'failure', -240, 'quality'),
  fullRun(runBase + 8, 'failure', -180, 'build-android'),
  fullRun(runBase + 9, 'failure', -120, 'deploy'),
  scenario(runBase + 10, 'cancelled', [workflowJob(runBase + 10, 1, 'quality', 'cancelled', -60)], -60),
];

(async () => {
  for (const run of runs) {
    const signals = buildSignals(run, run.jobs, 'github-actions-workflow-telemetry');
    const status = await exportSignals(endpoint, process.env.OTEL_EXPORTER_OTLP_HEADERS || '', signals);
    console.log(`${run.id}: ${signals.result}, trace=${signals.traceId}, ${status}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
