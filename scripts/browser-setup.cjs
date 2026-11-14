#!/usr/bin/env node
// Source-checkout convenience only. The same helper ships with every runtime.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const entry = join(__dirname, '../apps/backend/dist/browser-host/cli.js');
if (!existsSync(entry)) {
  console.error('Build the backend first: pnpm backend:build');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
  const stop = signal => { child.kill(signal); };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', code => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? 1;
  });
}
