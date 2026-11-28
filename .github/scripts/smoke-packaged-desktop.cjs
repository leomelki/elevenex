const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function smoke(executable) {
  const profile = await mkdtemp(join(tmpdir(), 'elevenex-package-'));
  const env = { ...process.env, HOME: profile, XDG_CONFIG_HOME: profile, APPDATA: profile, USERPROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
  let child;
  let exited;
  let logs = '';
  try {
    // Run on a disposable runner with an ephemeral loopback debugging port.
    child = spawn(resolve(executable), [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-logging=stderr',
    ], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    exited = once(child, 'close');
    const closed = exited.then(([code, signal]) => {
      throw new Error(`Packaged app exited early (${signal ?? code})`);
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { logs = (logs + chunk).slice(-16384); });
    }
    await Promise.race([closed, checkWindow(profile, signal)]);
    console.log('Packaged desktop rendered Machine Home over app:// and answered preload IPC.');
  } catch (error) {
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    controller.abort();
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited?.catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
}

async function checkWindow(profile, signal) {
  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  while (!port) {
    // The port file may be absent or locked while Chromium writes it on Windows.
    const contents = await readFile(portFile, { encoding: 'utf8', signal }).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'EBUSY') return '';
      throw error;
    });
    const match = /^(\d+)\r?\n\/devtools\/browser\//.exec(contents);
    if (match) port = Number(match[1]);
    if (!port) await delay(100, undefined, { signal }).catch(error => {
      throw new Error('Timed out waiting for the packaged app to write DevToolsActivePort', { cause: error });
    });
  }
  let page;
  while (!page) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });
    assert.ok(response.ok, `DevTools target discovery returned ${response.status}`);
    page = (await response.json()).find(target => target.type === 'page' && target.url.startsWith('app://elevenex/'));
    if (!page) await delay(100, undefined, { signal });
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await once(socket, 'open', { signal });
    let bridge;
    for (let id = 1; !bridge; id++) {
      const response = once(socket, 'message', { signal });
      socket.send(JSON.stringify({
        id, method: 'Runtime.evaluate', params: {
          expression: `(async () => document.querySelector('ex-machine-home h1') ? {
              platform: window.elevenex.platform,
              version: await window.elevenex.appVersion(),
              backendVersion: (await window.elevenex.backendStatus()).version,
              requireType: typeof window.require,
            } : null)()`,
          awaitPromise: true, returnByValue: true,
        },
      }));
      const [message] = await response;
      const reply = JSON.parse(message.data);
      assert.equal(reply.id, id);
      // Target discovery can find app:// before Electron commits the document.
      const navigating = reply.error?.code === -32000 &&
        /Execution context was destroyed|Cannot find (?:default )?execution context/i.test(reply.error.message);
      if (!navigating) {
        assert.ok(!reply.error && !reply.result.exceptionDetails, JSON.stringify(reply));
        bridge = reply.result.result.value;
      }
      if (!bridge) await delay(100, undefined, { signal });
    }
    assert.equal(bridge.platform, process.platform);
    assert.match(bridge.version, /^\d+\.\d+\.\d+/);
    assert.equal(bridge.requireType, 'undefined');
    if (process.env.ELEVENEX_BACKEND_VERSION) assert.equal(bridge.backendVersion, process.env.ELEVENEX_BACKEND_VERSION);
  } finally {
    socket.close();
  }
}

const executable = process.argv[2];
if (!executable) throw new Error('Usage: smoke-packaged-desktop.cjs <executable>');
smoke(executable).catch(error => { console.error(error); process.exitCode = 1; });
