'use strict';

const { execute } = require('./collector');

function input(name, fallback = '') {
  return process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || fallback;
}

execute({
  githubToken: input('github-token'),
  repository: input('repository'),
  runId: input('run-id'),
  endpoint: input('otlp-endpoint'),
  headers: input('otlp-headers'),
  serviceName: input('service-name', 'github-actions-workflow-telemetry'),
  exportRequired: input('export-required', 'false').toLowerCase() === 'true',
}).then((result) => {
  console.log(`Exported ${result.spans.length} spans for trace ${result.traceId}: ${result.status}`);
}).catch((error) => {
  console.error(`workflow-telemetry: ${error.message}`);
  process.exitCode = 1;
});
