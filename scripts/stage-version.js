const { execSync } = require('child_process');
const { mkdirSync, writeFileSync } = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const stageDir = path.join(repoRoot, 'apps', 'electron', '.stage');
const versionPath = path.join(stageDir, 'version');

mkdirSync(stageDir, { recursive: true });

const commitSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
writeFileSync(versionPath, commitSha, 'utf8');

console.log(`Staged version ${commitSha} at ${versionPath}`);
