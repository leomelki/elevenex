const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chmod, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SshEnvironment, captureLoginShell, mergeSshEnvironment, parseEnvironment } = require('../dist/remote/ssh-environment');
const { spawnSsh } = require('../dist/remote/ssh');

const dump = entries => `>>>ELEVENEX_SSH_ENV<<<${entries.map(entry => `${entry}\0`).join('')}>>>ELEVENEX_SSH_ENV_END<<<`;

test('parses only the delimited environment dump', () => {
  assert.deepEqual(parseEnvironment(`Last login: today\n${dump(['A=1', 'MULTI=one\ntwo=three', 'bad key=x'])}bye\n`), { A: '1', MULTI: 'one\ntwo=three' });
  assert.equal(parseEnvironment('banner without a dump'), undefined);
  assert.equal(parseEnvironment('>>>ELEVENEX_SSH_ENV<<<A=1\0'), undefined);
});

test('uses the terminal PATH order and values the shell changed', () => {
  const merged = mergeSshEnvironment(
    { PATH: '/usr/bin:/bin:/usr/sbin', SSH_AUTH_SOCK: '/launchd/agent', KEEP: 'inherited' },
    { PATH: '/opt/tools/bin:/usr/bin', SSH_AUTH_SOCK: '/agent/from/rc', PWD: '/capture', SHLVL: '2' }, 'darwin');
  assert.deepEqual(merged.PATH.split(':').slice(0, 4), ['/opt/tools/bin', '/usr/bin', '/bin', '/usr/sbin']);
  assert.ok(merged.PATH.split(':').includes('/opt/homebrew/bin'));
  assert.equal(merged.SSH_AUTH_SOCK, '/agent/from/rc');
  assert.equal(merged.KEEP, 'inherited');
  assert.equal(merged.PWD, undefined); assert.equal(merged.SHLVL, undefined);
});

test('waits for the first capture, then serves the cache while refreshing', async () => {
  let now = 0; const captures = []; const release = [];
  const environment = new SshEnvironment({ inherited: { PATH: '/usr/bin' }, platform: 'darwin', maxAgeMs: 100, now: () => now,
    capture: () => { captures.push(now); return new Promise(resolve => release.push(resolve)); } });
  const first = environment.read(new AbortController().signal);
  const concurrent = environment.read(new AbortController().signal);
  assert.equal(captures.length, 1, 'concurrent connections share one shell');
  release.shift()({ PATH: '/first/bin' });
  assert.match((await first).PATH, /^\/first\/bin:/); assert.match((await concurrent).PATH, /^\/first\/bin:/);
  now = 200;
  assert.match((await environment.read(new AbortController().signal)).PATH, /^\/first\/bin:/, 'stale value is returned immediately');
  assert.equal(captures.length, 2);
  release.shift()(undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match((await environment.read(new AbortController().signal)).PATH, /^\/first\/bin:/, 'a failed refresh keeps the last capture');
  environment.dispose();
});

test('a failed or cancelled first capture does not block connections', async () => {
  const failing = new SshEnvironment({ inherited: { PATH: '/usr/bin' }, platform: 'linux', capture: async () => { throw new Error('no shell'); } });
  assert.match((await failing.read(new AbortController().signal)).PATH, /^\/usr\/bin:/);
  const hanging = new SshEnvironment({ inherited: { PATH: '/usr/bin' }, platform: 'linux', capture: () => new Promise(() => undefined) });
  const cancelled = new AbortController(); const read = hanging.read(cancelled.signal); cancelled.abort(new Error('cancelled'));
  await assert.rejects(read, /cancelled/);
  const windows = new SshEnvironment({ inherited: { Path: 'C:\\Windows' }, platform: 'win32', capture: () => assert.fail('Windows has no login shell capture') });
  assert.deepEqual(await windows.read(new AbortController().signal), { Path: 'C:\\Windows' });
});

test('captures the login shell and lets OpenSSH find config commands on its PATH', { timeout: 20000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX login shell');
  const root = await mkdtemp(join(tmpdir(), 'ex-ssh-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, 'tools');
  await writeFile(join(root, 'shell'), `#!/bin/sh\necho 'rc banner'\nexport PATH='${tools}':"$PATH" FROM_RC=yes\nexec /bin/sh -c "$4"\n`, { mode: 0o700 });
  await mkdir(tools);
  await writeFile(join(tools, 'fixture-proxy'), '#!/bin/sh\necho EX11_PROXY_REACHED >&2\nexit 1\n', { mode: 0o700 });
  await chmod(join(root, 'shell'), 0o700);
  const inherited = { HOME: process.env.HOME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: join(root, 'shell') };
  const shell = await captureLoginShell(inherited, 5000, new AbortController().signal);
  assert.equal(shell.FROM_RC, 'yes'); assert.equal(shell.PATH.split(':')[0], tools);

  await writeFile(join(root, 'config'), 'Host fixture\n  ProxyCommand fixture-proxy\n  ControlPath none\n');
  const connect = async environment => {
    const ssh = await spawnSsh({ id: 'fixture', name: 'fixture', host: 'fixture', configFile: join(root, 'config') }, 'true', async () => null, false,
      AbortSignal.timeout(10000), require.resolve('../dist/remote/askpass-helper.js'), undefined, environment);
    ssh.child.stdin.end(); await ssh.exited; await ssh.stop(); return ssh.diagnostics();
  };
  // OpenSSH runs ProxyCommand through $SHELL; use a real shell for the connection.
  const missing = await connect({ ...inherited, SHELL: '/bin/sh' });
  assert.doesNotMatch(missing, /EX11_PROXY_REACHED/, 'a launchd-style PATH cannot find the tool');
  assert.match(missing, /not found/);
  assert.match(await connect({ ...mergeSshEnvironment(inherited, shell), SHELL: '/bin/sh' }), /EX11_PROXY_REACHED/);
});

test('a hanging login shell is stopped at the deadline', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX login shell');
  const root = await mkdtemp(join(tmpdir(), 'ex-ssh-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'shell'), '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
  const started = Date.now();
  assert.equal(await captureLoginShell({ PATH: '/usr/bin:/bin', SHELL: join(root, 'shell') }, 300, new AbortController().signal), undefined);
  assert.ok(Date.now() - started < 3000);
});
