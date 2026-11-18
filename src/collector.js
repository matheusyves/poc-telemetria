'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

function hash(value, size) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, size);
}

function nanos(value, fallback) {
  const parsed = value ? Date.parse(value) : NaN;
  return String(Number.isNaN(parsed) ? fallback : parsed * 1_000_000);
}

function asAttribute(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number' && Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  return { key, value: { stringValue: String(value) } };
}

function attributes(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => asAttribute(key, value));
}

function normalizeResult(conclusion) {
  const value = (conclusion || 'error').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'cancelled') return 'cancellation';
  if (value === 'skipped' || value === 'neutral' || value === 'stale') return 'skip';
  if (value === 'timed_out') return 'timeout';
  if (FAILURE_CONCLUSIONS.has(value)) return value === 'failure' ? 'failure' : 'error';
  return 'error';
}

function statusFor(result) {
  return result === 'success' || result === 'skip' ? { code: 1 } : { code: 2, message: result };
}

function errorType(result) {
  const types = { failure: 'workflow.failure', error: 'workflow.infrastructure_error', timeout: 'workflow.timeout', cancellation: 'workflow.cancelled' };
  return types[result];
}

function span({ traceId, spanId, parentSpanId, name, startedAt, endedAt, result, attrs, kind = 1 }) {
  const resultAttrs = { ...attrs };
  const type = errorType(result);
  if (type) resultAttrs['error.type'] = type;
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind,
    startTimeUnixNano: nanos(startedAt, Date.now() * 1_000_000),
    endTimeUnixNano: nanos(endedAt, Date.now() * 1_000_000),
    status: statusFor(result),
    attributes: attributes(resultAttrs),
  };
}

function durationSeconds(startedAt, endedAt) {
  const start = Date.parse(startedAt || '');
  const end = Date.parse(endedAt || '');
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, (end - start) / 1000);
}

function buildSignals(run, jobs, serviceName) {
  const traceId = hash(`${run.repository.full_name}:${run.id}`, 32);
  const rootSpanId = hash(`${run.id}:pipeline`, 16);
  const result = normalizeResult(run.conclusion);
  const resource = {
    'service.name': serviceName,
    'service.namespace': 'github-actions',
    'cicd.platform': 'github-actions',
    'vcs.repository.name': run.repository.full_name,
    'vcs.ref.head.revision': run.head_sha,
    'vcs.ref.head.name': run.head_branch,
  };
  const runUrl = run.html_url || `https://github.com/${run.repository.full_name}/actions/runs/${run.id}`;
  const root = span({
    traceId, spanId: rootSpanId, name: `RUN ${run.name}`, startedAt: run.run_started_at || run.created_at,
    endedAt: run.updated_at, result, kind: 2,
    attrs: {
      'cicd.pipeline.name': run.name,
      'cicd.pipeline.run.id': run.id,
      'cicd.pipeline.run.url.full': runUrl,
      'cicd.pipeline.action.name': 'RUN',
      'cicd.pipeline.result': result,
      'github.workflow.run_attempt': run.run_attempt,
      'github.workflow.event_name': run.event,
    },
  });
  const spans = [root];
  const logs = [{ timeUnixNano: root.endTimeUnixNano, severityNumber: result === 'success' ? 9 : 17, severityText: result === 'success' ? 'INFO' : 'ERROR', body: { stringValue: `Workflow ${run.name} completed with ${result}` }, traceId, spanId: rootSpanId, attributes: attributes({ 'cicd.pipeline.result': result, 'github.run.url': runUrl }) }];
  const workflowMetricPoints = [{ attributes: attributes({ repository: run.repository.full_name, workflow: run.name, result }), timeUnixNano: root.endTimeUnixNano, asDouble: durationSeconds(run.run_started_at || run.created_at, run.updated_at) }];
  const taskMetricPoints = [];

  for (const job of jobs) {
    const jobResult = normalizeResult(job.conclusion);
    const jobSpanId = hash(`${run.id}:job:${job.id}`, 16);
    const jobUrl = job.html_url || runUrl;
    spans.push(span({
      traceId, spanId: jobSpanId, parentSpanId: rootSpanId, name: `TASK ${job.name}`,
      startedAt: job.started_at || run.run_started_at, endedAt: job.completed_at || run.updated_at, result: jobResult,
      attrs: {
        'cicd.pipeline.task.name': job.name,
        'cicd.pipeline.task.run.id': job.id,
        'cicd.pipeline.task.run.url.full': jobUrl,
        'cicd.pipeline.task.run.result': jobResult,
        'github.job.runner_name': job.runner_name,
        'github.job.runner_group_name': job.runner_group_name,
      },
    }));
    logs.push({ timeUnixNano: nanos(job.completed_at, Date.now() * 1_000_000), severityNumber: jobResult === 'success' ? 9 : 17, severityText: jobResult === 'success' ? 'INFO' : 'ERROR', body: { stringValue: `Job ${job.name} completed with ${jobResult}` }, traceId, spanId: jobSpanId, attributes: attributes({ 'cicd.pipeline.task.name': job.name, 'cicd.pipeline.task.run.result': jobResult, 'github.job.url': jobUrl }) });
    taskMetricPoints.push({ attributes: attributes({ repository: run.repository.full_name, workflow: run.name, task: job.name, result: jobResult }), timeUnixNano: nanos(job.completed_at, Date.now() * 1_000_000), asDouble: durationSeconds(job.started_at, job.completed_at) });

    for (const step of job.steps || []) {
      const stepResult = normalizeResult(step.conclusion);
      const stepSpanId = hash(`${run.id}:job:${job.id}:step:${step.number}`, 16);
      spans.push(span({
        traceId, spanId: stepSpanId, parentSpanId: jobSpanId, name: `STEP ${step.name}`,
        startedAt: step.started_at || job.started_at, endedAt: step.completed_at || job.completed_at, result: stepResult,
        attrs: {
          'cicd.pipeline.task.name': step.name,
          'cicd.pipeline.task.run.id': `${job.id}:${step.number}`,
          'cicd.pipeline.task.run.url.full': jobUrl,
          'cicd.pipeline.task.run.result': stepResult,
          'github.job.id': job.id,
          'github.step.number': step.number,
        },
      }));
    }
  }
  const traces = { resourceSpans: [{ resource: { attributes: attributes(resource) }, scopeSpans: [{ scope: { name: 'github-actions-workflow-telemetry', version: '1.0.0' }, spans }] }] };
  const metrics = { resourceMetrics: [{ resource: { attributes: attributes(resource) }, scopeMetrics: [{ scope: { name: 'github-actions-workflow-telemetry', version: '1.0.0' }, metrics: [
    { name: 'cicd.pipeline.run.duration', description: 'Workflow completion duration in seconds.', unit: 's', gauge: { dataPoints: workflowMetricPoints } },
    { name: 'cicd.pipeline.task.run.duration', description: 'Workflow task completion duration in seconds.', unit: 's', gauge: { dataPoints: taskMetricPoints } },
  ] }] }] };
  const logPayload = { resourceLogs: [{ resource: { attributes: attributes(resource) }, scopeLogs: [{ scope: { name: 'github-actions-workflow-telemetry', version: '1.0.0' }, logRecords: logs }] }] };
  return { traceId, spans, traces, metrics, logs: logPayload, result };
}

function parseHeaders(raw) {
  return Object.fromEntries((raw || '').split(',').filter(Boolean).map((entry) => {
    const position = entry.indexOf('=');
    return position === -1 ? [entry.trim(), ''] : [entry.slice(0, position).trim(), entry.slice(position + 1).trim()];
  }));
}

function signalEndpoint(base, signal) {
  return `${base.replace(/\/$/, '').replace(/\/v1\/(traces|metrics|logs)$/, '')}/v1/${signal}`;
}

async function sendWithRetry(url, headers, payload) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
      if (response.ok) return response.status;
      lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
      if (response.status < 500) break;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError;
}

async function exportSignals(endpoint, headers, signals) {
  const parsedHeaders = parseHeaders(headers);
  const codes = await Promise.all([
    sendWithRetry(signalEndpoint(endpoint, 'traces'), parsedHeaders, signals.traces),
    sendWithRetry(signalEndpoint(endpoint, 'metrics'), parsedHeaders, signals.metrics),
    sendWithRetry(signalEndpoint(endpoint, 'logs'), parsedHeaders, signals.logs),
  ]);
  return `exported:${codes.join(',')}`;
}

async function githubGet(url, token) {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ao consultar ${url}`);
  return response.json();
}

async function listJobs(repository, runId, token) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const result = await githubGet(`https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`, token);
    jobs.push(...(result.jobs || []));
    if (jobs.length >= (result.total_count || 0) || !(result.jobs || []).length) return jobs;
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function appendSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function execute(input) {
  const run = await githubGet(`https://api.github.com/repos/${input.repository}/actions/runs/${input.runId}`, input.githubToken);
  const jobs = await listJobs(input.repository, input.runId, input.githubToken);
  const signals = buildSignals(run, jobs, input.serviceName);
  let status = 'not-configured';
  if (input.endpoint) {
    status = await exportSignals(input.endpoint, input.headers, signals);
  } else if (input.exportRequired) {
    throw new Error('OTLP endpoint é obrigatório, mas não foi informado');
  }
  setOutput('trace-id', signals.traceId);
  setOutput('span-count', signals.spans.length);
  setOutput('export-status', status);
  appendSummary(`## Workflow telemetry\n\n| Campo | Valor |\n| --- | --- |\n| Resultado | \`${signals.result}\` |\n| Trace ID | \`${signals.traceId}\` |\n| Spans | ${signals.spans.length} |\n| Exportação OTLP | \`${status}\` |`);
  return { ...signals, status };
}

module.exports = { buildSignals, execute, exportSignals, normalizeResult, signalEndpoint };
