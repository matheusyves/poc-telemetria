'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignals, normalizeResult, signalEndpoint } = require('../src/collector');

const run = {
  id: 42, name: 'Delivery pipeline', conclusion: 'failure', run_attempt: 1, event: 'workflow_dispatch',
  repository: { full_name: 'acme/app' }, head_sha: 'abc123', head_branch: 'main',
  run_started_at: '2026-11-17T12:00:00Z', updated_at: '2026-11-17T12:01:00Z',
  html_url: 'https://github.com/acme/app/actions/runs/42',
};

test('builds one trace across run, jobs and steps', () => {
  const signals = buildSignals(run, [{ id: 8, name: 'quality', conclusion: 'failure', started_at: run.run_started_at, completed_at: run.updated_at, html_url: run.html_url, steps: [{ number: 1, name: 'Run quality gate', conclusion: 'failure', started_at: run.run_started_at, completed_at: run.updated_at }] }], 'test');
  assert.equal(signals.spans.length, 3);
  assert.equal(signals.result, 'failure');
  assert.equal(signals.traces.resourceSpans[0].scopeSpans[0].spans[0].name, 'RUN Delivery pipeline');
  assert.equal(signals.traces.resourceSpans[0].scopeSpans[0].spans[2].name, 'STEP Run quality gate');
  const taskAttributes = Object.fromEntries(signals.spans[1].attributes.map((attribute) => [attribute.key, attribute.value.stringValue || attribute.value.intValue]));
  assert.equal(taskAttributes['cicd.pipeline.name'], 'Delivery pipeline');
  assert.equal(taskAttributes['cicd.pipeline.run.id'], '42');
  const metrics = signals.metrics.resourceMetrics[0].scopeMetrics[0].metrics;
  const executions = metrics.find((metric) => metric.name === 'cicd.workflow.executions');
  const durations = metrics.find((metric) => metric.name === 'cicd.workflow.duration');
  assert.equal(executions.sum.dataPoints.length, 2);
  assert.equal(executions.sum.aggregationTemporality, 1);
  assert.equal(durations.histogram.dataPoints.length, 2);
  assert.equal(durations.histogram.dataPoints[1].count, '1');
  assert.equal(durations.histogram.dataPoints[1].bucketCounts.reduce((sum, value) => sum + Number(value), 0), 1);
});

test('preserves cancellation and derives endpoints', () => {
  assert.equal(normalizeResult('cancelled'), 'cancellation');
  assert.equal(normalizeResult('timed_out'), 'timeout');
  assert.equal(signalEndpoint('http://collector:4318', 'logs'), 'http://collector:4318/v1/logs');
  assert.equal(signalEndpoint('https://gateway/otlp/v1/traces', 'metrics'), 'https://gateway/otlp/v1/metrics');
});
