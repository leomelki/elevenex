const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const vm = require('node:vm');

// Exercise the actual Electron functions without launching a desktop window.
const source = readFileSync(require.resolve('../main.cjs'), 'utf8');
function loadFunction(name, nextName, bindings) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, bindings);
}

test('an active SSH process with an unresponsive backend cannot reuse cached readiness', async () => {
  const cached = new Map([[17, { status: 'ready', localPort: 4000 }]]);
  const runtimes = new Map([[17, { status: 'active', localPort: 4400 }]]);
  let reachable = false;
  const reuse = loadFunction('reuseReadyRemoteServer', 'recordRemoteServerResult', {
    readyRemoteServers: cached,
    sshForwardRuntimes: runtimes,
    probeElevenexBackend: async () => reachable,
  });
  assert.equal(await reuse(17), null);
  reachable = true;
  assert.equal((await reuse(17)).localPort, 4400);
});

function commandRunner(script) {
  const cleanups = [];
  const runner = loadFunction('runSshCommandAsync', 'runSshCommand', {
    resolveSshConfigOutput: async () => 'hostname example.com',
    buildResolvedSshConfig: () => ({ configPath: '/unused', resolveArgs: ['-G'] }),
    createSshAskPassRuntime: () => null,
    buildSshTarget: () => 'example.com',
    getSshBaseArgs: () => [],
    getRemoteCommandArgs: () => [],
    cleanupSshArtifacts: (runtime) => cleanups.push(runtime),
    process,
    spawn: (_command, _args, options) => spawn(process.execPath, ['-e', script], options),
  });
  return { runner, cleanups };
}

test('SSH commands collect complete output before settling and clean their artifacts', async () => {
  const { runner, cleanups } = commandRunner("process.stdout.write('ready'); process.stderr.write('diagnostic');");
  const result = await runner({}, 'ignored');
  assert.equal(result.stdout, 'ready');
  assert.equal(result.stderr, 'diagnostic');
  assert.ok(cleanups.length > 0);
});

test('canceling an SSH attempt terminates its command and settles the pending promise', async () => {
  const { runner, cleanups } = commandRunner('setInterval(() => {}, 1000)');
  const controller = new AbortController();
  const pending = runner({ signal: controller.signal }, 'ignored');
  const canceled = assert.rejects(pending, /aborted/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await canceled;
  assert.ok(cleanups.length > 0);
});

test('a hanging SSH command has a process deadline and cannot wait forever', async () => {
  const { runner, cleanups } = commandRunner('setInterval(() => {}, 1000)');
  await assert.rejects(runner({}, 'ignored', { timeoutMs: 50 }), /ssh exited/);
  assert.ok(cleanups.length > 0);
});


test('SSH commands suppress credential prompts unless the user supplied a secret', () => {
  const start = source.indexOf('function getSshBaseArgs(');
  const end = source.indexOf('\nfunction encodePowershellCommand(', start);
  const args = vm.runInNewContext(`${source.slice(start, end)}; getSshBaseArgs`);
  assert.ok(args({ configPath: '/unused' }, 'example.com').includes('BatchMode=yes'));
  assert.ok(args({ configPath: '/unused' }, 'example.com', {}).includes('BatchMode=no'));
});
