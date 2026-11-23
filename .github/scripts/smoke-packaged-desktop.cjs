const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
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
    child = spawn(resolve(executable), ['--remote-debugging-port=0', '--enable-logging=stderr'], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    exited = once(child, 'close');
    const closed = exited.then(([code, signal]) => {
      throw new Error(`Packaged app exited early (${signal ?? code})`);
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { logs = (logs + chunk).slice(-16384); });
    }
    await Promise.race([closed, checkWindow(() => logs, signal)]);
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

async function checkWindow(readLogs, signal) {
  let port;
  while (!port) {
    await delay(100, undefined, { signal });
    port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\//.exec(readLogs())?.[1];
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
    socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: {
        expression: `(async () => {
          while (!document.querySelector('ex-machine-home h1')) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return {
            platform: window.elevenex.platform,
            version: await window.elevenex.appVersion(),
            backendVersion: (await window.elevenex.backendStatus()).version,
            requireType: typeof window.require,
          };
        })()`,
        awaitPromise: true, returnByValue: true,
      },
    }));
    const [message] = await once(socket, 'message', { signal });
    const reply = JSON.parse(message.data);
    assert.equal(reply.id, 1);
    assert.ok(!reply.error && !reply.result.exceptionDetails, JSON.stringify(reply));
    const bridge = reply.result.result.value;
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
