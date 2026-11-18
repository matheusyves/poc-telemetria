'use strict';

const { buildSignals, exportSignals } = require('../src/collector');

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const now = Date.now();
const runBase = Number(process.env.DEMO_RUN_BASE || Math.floor(now / 1000));
const profile = process.env.DEMO_PROFILE || 'mixed';
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

const mixedRuns = [
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

function sloRuns(successCount) {
  const successes = Array.from({ length: successCount }, (_, index) => {
    const offset = -((successCount + 1 - index) * 60);
    return fullRun(runBase + index + 1, 'success', offset);
  });
  const failedRunId = runBase + successCount + 1;
  const incident = scenario(failedRunId, 'failure', [
    workflowJob(failedRunId, 1, 'quality', 'failure', -60),
    workflowJob(failedRunId, 2, 'build-android', 'failure', -50),
    workflowJob(failedRunId, 3, 'security', 'failure', -40),
    workflowJob(failedRunId, 4, 'deploy', 'failure', -30),
  ], -60);
  return [...successes, incident];
}

const runs = profile === 'slo' ? sloRuns(Number(process.env.DEMO_SUCCESS_RUNS || 19)) : mixedRuns;

(async () => {
  const outcomes = { success: 0, failure: 0, cancellation: 0 };
  for (const run of runs) {
    const signals = buildSignals(run, run.jobs, 'github-actions-workflow-telemetry');
    const status = await exportSignals(endpoint, process.env.OTEL_EXPORTER_OTLP_HEADERS || '', signals);
    outcomes[signals.result] = (outcomes[signals.result] || 0) + 1;
    if (runs.length <= 20) console.log(`${run.id}: ${signals.result}, trace=${signals.traceId}, ${status}`);
  }
  console.log(`Generated ${runs.length} runs: ${JSON.stringify(outcomes)}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
