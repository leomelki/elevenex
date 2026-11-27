const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, readdir, rm } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { installFromServer } = require('../dist/remote/server-install');
const { bootstrapScript } = require('../dist/remote/runtime-install');
const { shellQuote } = require('../dist/remote/ssh');
const { backendRelease } = require('../dist/backend/release');
const { downloadBackend } = require('../dist/backend/download');
const { archive, releaseFetch, tar, version } = require('./backend-fixtures.cjs');
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
const launcherDefinition = /^( *Add-Type -OutputAssembly .*'runtime-launcher\.exe'.* -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@)$/m;

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'ex-remote-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('server download retries twice, verifies with the shared validators and cleans staging', async t => {
  const root = await temporary(t); let attempts = 0;
  const bytes = archive(); const remote = releaseFetch(release, bytes);
  await installFromServer(root, release, AbortSignal.timeout(10000), () => {}, async (...args) => {
    if (++attempts < 3) throw new Error('temporary network outage');
    return downloadBackend(...args, remote.request);
  });
  assert.equal(attempts, 3);
  assert.equal(await readFile(join(root, 'backend/main.cjs'), 'utf8'), 'console.log("backend");');
  assert.equal(await readFile(join(root, 'installation.sha256'), 'utf8'), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual((await readdir(root)).sort(), ['backend', 'installation.sha256']);
});

test('server checksum and unsafe archive failures never publish an installation', async t => {
  for (const unsafe of [false, true]) {
    const root = await temporary(t); let attempts = 0;
    const remote = releaseFetch(release, unsafe ? tar([{ name: 'backend/../escape', body: 'unsafe' }]) : archive(), unsafe ? {} : { checksum: '0'.repeat(64) });
    await assert.rejects(installFromServer(root, release, AbortSignal.timeout(10000), () => {}, async (...args) => {
      attempts++; return downloadBackend(...args, remote.request);
    }), /three attempts/);
    assert.equal(attempts, 3); assert.deepEqual(await readdir(root), []);
  }
});

test('cancellation during server retry backoff cleans up and stops subsequent attempts', async t => {
  const root = await temporary(t); const controller = new AbortController(); let attempts = 0;
  const operation = installFromServer(root, release, controller.signal, () => {}, async () => {
    attempts++; setTimeout(() => controller.abort(), 20); throw new Error('offline');
  });
  await assert.rejects(operation, /abort/i); assert.equal(attempts, 1); assert.deepEqual(await readdir(root), []);
});

for (const mode of ['server', 'fallback', 'development']) test(`native bootstrap uses ${mode} installation`, async t => {
  const fails = mode === 'fallback'; const development = mode === 'development';
  if (process.platform === 'win32') return t.skip('POSIX remote bootstrap');
  const home = await temporary(t); const bin = join(home, 'bin'); await mkdir(bin);
  // This preload is confined to the test's node wrapper. Production URLs and
  // every validator remain unchanged; no external service is contacted.
  const bytes = tar([
    { name: 'backend/main.cjs', body: 'fixture' },
    { name: 'backend/node/bin/node', body: '#!/bin/sh\nif [ "$#" -eq 4 ] && [ "$1" = "-e" ]; then mv "$3" "$4"; fi\nexit 0\n', mode: 0o700 },
  ]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const preload = join(home, 'fetch.cjs');
  const calls = join(home, 'calls');
  await writeFile(preload, `globalThis.fetch=async url=>{require('fs').appendFileSync(${JSON.stringify(calls)},'1');if(${fails})throw Error('offline');return String(url).endsWith('.sha256')?new Response('${digest}  ${release.archiveName}'):new Response(Buffer.from('${bytes.toString('base64')}','base64'));};`);
  await writeFile(join(bin, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} --require ${shellQuote(preload)} "$@"\n`, { mode: 0o700 });
  const nonce = randomBytes(16).toString('hex');
  const namespace = development ? 'd'.repeat(32) : undefined;
  const { command, payload } = await bootstrapScript(release, nonce, !development, namespace);
  const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(() => child.kill('SIGTERM'));
  child.stdin.write(payload);
  let output = ''; let diagnostics = ''; let sent = false;
  child.stderr.on('data', data => { diagnostics += data; });
  child.stdout.on('data', data => {
    output += data;
    if (output.includes(`EX11:${nonce}:cache:no`) && !sent) {
      sent = true; child.stdin.end(Buffer.concat([Buffer.from(`${bytes.length} ${digest}\n`), bytes]));
    }
  });
  assert.equal(await exited, 0, diagnostics); assert.equal(sent, fails || development);
  if (development) await assert.rejects(readFile(calls), { code: 'ENOENT' });
  else assert.equal((await readFile(calls, 'utf8')).length, fails ? 3 : 2);
  const root = join(home, '.elevenex', development ? `desktop-remote-dev/${namespace}` : 'desktop-remote', 'runtimes');
  assert.deepEqual(await readdir(root), [`${release.tag}-${release.target}`]);
  assert.equal(await readFile(join(root, `${release.tag}-${release.target}`, 'installation.sha256'), 'utf8'), digest);
  assert.match(output, /installation:start/); assert.match(output, /runtime:start/);
});

test('Windows bootstrap transfers the complete immutable bridge as an exact-length payload', async () => {
  const { bootstrapWindowsScript } = require('../dist/remote/runtime-install-windows');
  const { remoteClientSources } = require('../dist/remote/runtime-sources');
  const { gunzipSync } = require('node:zlib');
  const nonce = 'a'.repeat(32);
  const { command, payload } = await bootstrapWindowsScript(release, nonce, 'c'.repeat(32), true);
  const loader = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(command.length < 8191, 'Windows cmd.exe command line limit');
  assert.ok(loader.includes('[byte[]]::new(' + payload.length + ')'));
  const script = gunzipSync(payload).toString('utf8');
  const { modules, sources, clientId } = await remoteClientSources();
  const entries = [...script.matchAll(/^Write-Module '([^']+)' '([a-zA-Z0-9+/=]+)'$/gm)];
  assert.deepEqual(entries.map(match => match[1]), modules.map(name => name + '.js'));
  assert.deepEqual(entries.map(match => Buffer.from(match[2], 'base64').toString('utf8')), sources);
  const launcher = launcherDefinition.exec(script);
  assert.ok(launcher);
  const windowsClientId = createHash('sha256').update(clientId).update(launcher[2] + '\n').digest('hex');
  assert.ok(script.includes(windowsClientId));
  assert.match(script, /New-ScheduledTaskAction -Execute \$launcher -Argument \$arguments/);
  assert.ok(script.includes('EX11:' + nonce + ':platform:win32:'));
  for (const invalid of ["bad'nonce", 'g'.repeat(32)]) {
    await assert.rejects(bootstrapWindowsScript(release, invalid), /identity/);
    await assert.rejects(bootstrapWindowsScript(release, nonce, invalid), /identity/);
  }
  await assert.rejects(bootstrapWindowsScript({ ...release, tag: "runtime-'wrong" }, nonce), /release tag/);
});

test('the Windows scheduler launcher runs its daemon without a console and returns its exit code', { skip: process.platform !== 'win32' }, async t => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { gunzipSync } = require('node:zlib');
  const { bootstrapWindowsScript } = require('../dist/remote/runtime-install-windows');
  const execute = promisify(execFile);
  const artifacts = join(dirname(require.resolve('../../../package.json')), 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const stage = await mkdtemp(join(artifacts, 'launcher probe '));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const { payload } = await bootstrapWindowsScript(release, '1'.repeat(32));
  const compile = launcherDefinition.exec(gunzipSync(payload).toString('utf8'));
  assert.ok(compile);
  const probeSource = `
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  public static int Main(string[] args) {
    if (IsWindowVisible(GetConsoleWindow())) return 90;
    if (args.Length != 5 || args[1] != "daemon" ||
        !String.Equals(Directory.GetCurrentDirectory(), args[2], StringComparison.OrdinalIgnoreCase)) return 91;
    File.WriteAllLines(args[0], args);
    return 42;
  }
}
`;
  const runProbe = `$ErrorActionPreference='Stop'
$stage=$env:EX11_LAUNCHER_TEST_STAGE
${compile[1]}
$probe=Join-Path $stage 'probe.exe'
Add-Type -OutputAssembly $probe -OutputType ConsoleApplication -TypeDefinition @'
${probeSource}'@
$report=Join-Path $stage 'probe report.txt'
$cache=Join-Path $stage 'runtime cache'
$arguments='"'+$probe+'" "'+$report+'" "'+$stage+'" "'+$cache+'" ${version}'
$start=[Diagnostics.ProcessStartInfo]::new((Join-Path $stage 'runtime-launcher.exe'),$arguments)
$start.UseShellExecute=$false
try { $process=[Diagnostics.Process]::Start($start) }
catch {
  if ($_.Exception.GetBaseException().NativeErrorCode -in @(1260,4551)) {
    [Console]::WriteLine('blocked-by-application-control')
    exit 0
  }
  throw
}
try {
  if (!$process.WaitForExit(5000)) { $process.Kill(); throw 'Launcher timeout' }
  [Console]::WriteLine($process.ExitCode)
} finally { $process.Dispose() }`;
  const report = join(stage, 'probe report.txt');
  const cache = join(stage, 'runtime cache');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(runProbe, 'utf16le').toString('base64')], {
    env: { ...process.env, EX11_LAUNCHER_TEST_STAGE: stage, TEMP: stage, TMP: stage },
    windowsHide: true, timeout: 30000,
  });
  const executable = await readFile(join(stage, 'runtime-launcher.exe'));
  const peHeader = executable.readUInt32LE(0x3c);
  assert.equal(executable.readUInt16LE(peHeader + 24 + 68), 2, 'Windows GUI subsystem');
  if (stdout.trim() === 'blocked-by-application-control') return t.skip('Windows application control blocked execution of the compiled probe launcher');
  assert.equal(stdout.trim(), '42');
  assert.deepEqual((await readFile(report, 'utf8')).trimEnd().split(/\r?\n/), [report, 'daemon', stage, cache, version]);
});

test('Windows native loader rejects truncated stdin and installed PowerShell parses the full bootstrap', { skip: process.platform !== 'win32' }, async t => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const { gunzipSync } = require('node:zlib');
  const { bootstrapWindowsScript } = require('../dist/remote/runtime-install-windows');
  const { command, payload } = await bootstrapWindowsScript(release, '1'.repeat(32));
  const child = spawn('powershell.exe', command.split(' ').slice(1), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  child.stdin.end(payload.subarray(0, 8));
  assert.equal(await exited, 1);
  assert.match(diagnostics, /Incomplete installer payload/);
  const root = await temporary(t);
  const path = join(root, 'bootstrap.ps1');
  await writeFile(path, gunzipSync(payload));
  const parse = '$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile($env:EX11_PAYLOAD,[ref]$tokens,[ref]$errors); if ($errors.Count) { throw ($errors.Message -join ", ") }';
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parse], { env: { ...process.env, EX11_PAYLOAD: path } });
});

test('shell detection handles localized remote command errors, cached Windows hosts and SSH authentication failures', async () => {
  const { connectRemote } = require('../dist/remote/bootstrap');
  const { PassThrough } = require('node:stream');
  async function attempts(remoteShell, code, diagnostics) {
    const shells = [];
    await assert.rejects(connectRemote({ host: { id:'fixture', name:'Fixture', host:'fixture' }, root: tmpdir(),
      helper: '', interactive: true, signal: AbortSignal.timeout(3000), ask: async () => null, progress() {}, release, remoteShell,
      spawn: async (_host, command) => {
        shells.push(command.startsWith('powershell.exe') ? 'windows' : 'posix');
        const child = { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: shells.length === 1 ? code : 255 };
        return { child, exited: Promise.resolve(), diagnostics: () => shells.length === 1 ? diagnostics : 'Permission denied',
          stop: async () => { child.stdin.destroy(); child.stdout.destroy(); } };
      },
    }));
    return shells;
  }
  assert.deepEqual(await attempts(undefined, 1, 'sh : El término sh no se reconoce.'), ['posix', 'windows']);
  assert.deepEqual(await attempts('windows', 127, 'powershell.exe: introuvable'), ['windows', 'posix']);
  assert.deepEqual(await attempts(undefined, 255, 'Permission denied (publickey).'), ['posix']);
  assert.deepEqual(await attempts(undefined, 1, 'EX11_COMPATIBILITY: Install tar on the remote PATH'), ['posix']);
});
