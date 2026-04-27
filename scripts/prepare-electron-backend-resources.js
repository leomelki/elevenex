const { renameSync } = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const stageBackendRoot = path.join(repoRoot, 'apps', 'electron', '.stage', 'backend');

renameSync(
  path.join(stageBackendRoot, 'node_modules'),
  path.join(stageBackendRoot, '_node_modules'),
);

console.log('Renamed node_modules → _node_modules in staged backend');
