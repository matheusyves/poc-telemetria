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

const runs = [
  scenario(runBase + 1, 'success', [job(runBase + 11, 'quality', 'success', -180), job(runBase + 12, 'build-android', 'success', -170), job(runBase + 13, 'security', 'success', -160), job(runBase + 14, 'deploy', 'success', -150)], -180),
  scenario(runBase + 2, 'failure', [job(runBase + 21, 'quality', 'failure', -120)], -120),
  scenario(runBase + 3, 'failure', [job(runBase + 31, 'quality', 'success', -60), job(runBase + 32, 'build-android', 'success', -50), job(runBase + 33, 'security', 'success', -40), job(runBase + 34, 'deploy', 'failure', -30)], -60),
];

(async () => {
  for (const run of runs) {
    const signals = buildSignals(run, run.jobs, 'github-actions-workflow-telemetry');
    const status = await exportSignals(endpoint, process.env.OTEL_EXPORTER_OTLP_HEADERS || '', signals);
    console.log(`${run.id}: ${signals.result}, trace=${signals.traceId}, ${status}`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
