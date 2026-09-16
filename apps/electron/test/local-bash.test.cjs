'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const { runLocalBash } = require('../local-bash.cjs');

test('local Bash is denied by default', async () => {
  await assert.rejects(
    runLocalBash({ command: 'printf nope' }, { enabled: false }),
    /disabled/,
  );
});

test('local Bash captures stdout, stderr and exit status', async () => {
  if (process.platform === 'win32') return;
  const result = await runLocalBash(
    { command: 'printf out; printf err >&2; exit 7', cwd: os.tmpdir() },
    { enabled: true },
  );
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.exitCode, 7);
  assert.equal(result.cwd, os.tmpdir());
});
