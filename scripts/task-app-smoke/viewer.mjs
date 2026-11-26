import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startProcess, testEnvironment, until, unusedPort } from './common.mjs';
import { connectPage } from './cdp.mjs';

export async function startViewer(binary, home, { host, projectId, taskId, sessionId }, signal, cleanup) {
  const env = testEnvironment(home);
  const profile = join(env.XDG_CONFIG_HOME, 'Elevenex Desktop');
  const selection = { kind: 'remote', hostId: host.id };
  const context = {
    projectId, taskId, sessionId, draft: '', cursor: null,
    workspace: {
      panel: 'apps', panelOpen: true, wideReview: false, closed: false, focused: false,
      filter: null, projectCursor: null, taskCursor: null,
    },
  };
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'remote-settings.json'), JSON.stringify({
    version: 1, hosts: [host], windows: [{ selection, contexts: { [host.id]: context }, connect: true, forwards: {} }],
  }));
  const port = await unusedPort();
  const viewer = startProcess(binary, [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
  ], { env });
  cleanup.push(() => viewer.stop());
  const address = 'http://127.0.0.1:' + port;
  const startup = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  await until('opening the packaged desktop', () => {
    viewer.assertAlive();
    return fetch(address + '/json/version', { signal: startup }).then(reply => reply.ok).catch(() => false);
  }, startup);
  const targets = () => fetch(address + '/json/list', { signal }).then(reply => reply.json());
  const attach = target => connectPage(target, signal, cleanup);
  const target = await until('loading the packaged app protocol', async () =>
    (await targets()).find(candidate => candidate.type === 'page' && candidate.url.startsWith('app://')), startup);
  const page = await attach(target);
  try {
    await clickControl(page, 'button[data-machine="' + host.id + '"]', 'SSH machine', signal, false);
    const scope = await until('connecting the packaged desktop over SSH', () => page.evaluate(async hostId => {
      const state = await window.elevenex.backendClientState();
      return state.scope?.environment.kind === 'remote' && state.scope.environment.hostId === hostId && state.scope.id;
    }, host.id), startup);
    console.log('Opened the task machine in the packaged desktop over SSH');
    return { page, targets, attach, scope, viewer };
  } catch (error) {
    const diagnostic = await page.evaluate(() => document.body?.innerText.slice(0, 1500)).catch(() => '');
    throw new Error('Packaged desktop did not open the SSH machine. ' + diagnostic + '\n' + viewer.diagnostics(), { cause: error });
  }
}

async function controlPoint(page, selector, label, matchLabel = true) {
  return page.evaluate(async ({ selector, label, matchLabel }) => {
    const controls = [...document.querySelectorAll(selector)];
    for (const control of controls) {
      if (control.disabled || control.closest('[inert],[hidden]')) continue;
      if (matchLabel && (control.getAttribute('aria-label') ?? control.textContent.trim()) !== label) continue;
      const box = control.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (!control.contains(document.elementFromPoint(x, y))) continue;
      // The panel can still be sliding in when its button first passes the hit
      // test. Wait for stable geometry before issuing one trusted click.
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      const settled = control.getBoundingClientRect();
      if (control.isConnected && !control.disabled && Math.abs(settled.x - box.x) < 0.5 &&
          Math.abs(settled.y - box.y) < 0.5 && control.contains(document.elementFromPoint(x, y))) return { x, y };
    }
    return null;
  }, { selector, label, matchLabel });
}

async function clickControl(page, selector, label, signal, matchLabel) {
  const point = await until('finding ' + label, () => controlPoint(page, selector, label, matchLabel),
    AbortSignal.any([signal, AbortSignal.timeout(20000)]));
  await page.click(point.x, point.y);
}

export async function verifyApp({ page, targets, attach, scope }, task, signal, screenshot) {
  const identity = { scope, taskId: task.taskId, runId: task.runId };
  const output = () => page.evaluate(({ scope, taskId, runId }) =>
    window.elevenex.taskAppOutput(scope, taskId, runId), identity);
  const apps = '[role=tabpanel][aria-label=Apps]';
  await clickControl(page, apps + ' [aria-label="App launch request"] button', 'Launch on machine', signal);
  await until('launching the approved Electron fixture', async () => {
    const result = await output();
    return result.ok && result.value.includes('fixture-ready');
  }, AbortSignal.any([signal, AbortSignal.timeout(30000)]));
  console.log('Approved the agent proposal from the Apps panel');

  const canvasSelector = 'canvas:not([hidden])';
  const canvasPoint = (page, fraction) => page.evaluate(({ selector, fraction }) => {
    const canvas = document.querySelector(selector);
    if (!canvas || canvas.width <= 1 || canvas.height <= 1) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return { x: box.x + box.width * fraction, y: box.y + box.height / 5 };
  }, { selector: canvasSelector, fraction });
  const windowTarget = async () => (await targets()).find(target => target.url.includes('/app-window'));
  const openWindow = async () => {
    await clickControl(page, apps + ' button', 'Open app in separate window', signal);
    const target = await until('opening the Apps companion', windowTarget, signal);
    const window = await attach(target);
    await until('decoding the remote Electron canvas', () => canvasPoint(window, .2), signal);
    return window;
  };
  const color = page => page.evaluate(selector => {
    const canvas = document.querySelector(selector);
    return canvas.getContext('2d').getImageData(Math.floor(canvas.width / 5), Math.floor(canvas.height / 5), 1, 1).data[0] > 128;
  }, canvasSelector);
  async function typeAndCheck(window, text, fixtureText) {
    const before = await color(window);
    const start = performance.now();
    await window.command('Input.insertText', { text });
    const sampleSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    try {
      await until('waiting for an updated frame after typing', async () => await color(window) !== before, sampleSignal, 5);
    } catch (error) {
      const result = await output();
      throw new Error('Remote Electron frame did not change after typing. ' +
        (result.ok ? result.value.slice(-500) : JSON.stringify(result).slice(0, 500)), { cause: error });
    }
    const duration = Math.round(performance.now() - start);
    if (fixtureText) {
      await until('checking the Electron input receipt', async () => {
        const result = await output();
        return result.ok && result.value.includes('fixture-text-' + fixtureText);
      }, sampleSignal);
    }
    return duration;
  }

  let window = await openWindow();
  let point = await canvasPoint(window, .2);
  assert.ok(point, 'Remote Electron canvas must be visible');
  await window.click(point.x, point.y);
  await window.key('a', 'KeyA', 65, 'a');
  await until('checking native keyboard input and its returned frame', async () => {
    const result = await output();
    return result.ok && result.value.includes('fixture-text-a') && !(await color(window));
  }, signal);
  console.log('Typed into the remote Electron window and verified the returned frame');

  const samples = [];
  for (let index = 0; index < 35; index++) {
    const duration = await typeAndCheck(window, 'x');
    if (index >= 5) samples.push(duration);
  }
  samples.sort((a, b) => a - b);
  console.log('Input to changed canvas over SSH (ms, 30 samples): p50=' + samples[14] +
    ' p95=' + samples[28] + ' max=' + samples[29]);
  const shot = await window.command('Page.captureScreenshot');
  await writeFile(screenshot, Buffer.from(shot.data, 'base64'));

  await window.command('Page.close');
  await until('closing the Apps companion', async () => !await windowTarget(), signal);
  // Reopen the real companion and prove that the same Electron process still
  // has the previous text and takes input through the new stream attachment.
  await clickControl(page, apps + ' button', 'View here', signal);
  window = await openWindow();
  point = await canvasPoint(window, .9);
  assert.ok(point);
  await window.click(point.x, point.y);
  await window.key('End', 'End', 35);
  await typeAndCheck(window, 'z', 'a' + 'x'.repeat(35) + 'z');
  await clickControl(window, 'button', 'Stop app', signal);
  await until('stopping the remote Electron fixture', () =>
    window.evaluate(() => [...document.querySelectorAll('h2')].some(heading => heading.textContent.trim() === 'App exited')), signal);
  console.log('Reattached to the same Electron process, verified input, and stopped it from the viewer');
}
