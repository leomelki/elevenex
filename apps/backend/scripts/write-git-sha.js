#!/usr/bin/env node
const { execSync } = require('child_process');
const { writeFileSync, mkdirSync } = require('fs');
const path = require('path');

function resolveSha() {
  const fromEnv = process.env.GIT_SHA || process.env.BACKEND_SHA || process.env.SOURCE_COMMIT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const sha = resolveSha();
const outDir = path.join(__dirname, '..', 'src', 'generated');
const outFile = path.join(outDir, 'git-sha.ts');

mkdirSync(outDir, { recursive: true });
writeFileSync(
  outFile,
  `// Auto-generated at build time by scripts/write-git-sha.js. Do not edit.\nexport const GIT_SHA = '${sha}';\n`,
);

console.log(`[write-git-sha] wrote ${outFile} (${sha})`);
