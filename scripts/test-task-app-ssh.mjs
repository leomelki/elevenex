import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { desktop, root } from './task-app-smoke/common.mjs';
import { startTaskHost } from './task-app-smoke/host.mjs';
import { startViewer, verifyApp } from './task-app-smoke/viewer.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'rtt-ms': { type: 'string', default: '0' },
    'down-kbps': { type: 'string', default: '0' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/test-task-app-ssh.mjs [--rtt-ms 0..200] [--down-kbps 0..100000]');
    return;
  }
  const rttMs = Number(values['rtt-ms']);
  assert.ok(Number.isInteger(rttMs) && rttMs >= 0 && rttMs <= 200, '--rtt-ms must be between 0 and 200');
  const kbps = Number(values['down-kbps']);
  assert.ok(Number.isInteger(kbps) && kbps >= 0 && kbps <= 100_000, '--down-kbps must be between 0 and 100000');
  assert.equal(process.platform, 'linux', 'This smoke test uses a disposable Linux OpenSSH host');
  assert.ok(process.env.DISPLAY, 'Run on a graphical desktop or with xvfb-run');
  const target = process.arch === 'x64' ? 'linux-unpacked' : 'linux-' + process.arch + '-unpacked';
  const binary = join(desktop, 'release', target, 'elevenex-desktop');
  await access(binary, constants.X_OK).catch(error => {
    throw new Error('Build the Linux packaged desktop with pnpm desktop:package --linux --dir', { cause: error });
  });
  // The managed backend uses Unix sockets under this directory. Keep the
  // prefix short enough for sockaddr_un, including on shared build machines.
  const directory = await mkdtemp('/tmp/ea-');
  const output = join(root, 'artifacts/task-apps');
  const screenshot = join(output, `packaged-ssh-${rttMs}ms${kbps ? `-${kbps}kbps` : ''}.png`);
  const cleanup = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Interrupted'));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(360000)]);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let failure;
  try {
    await mkdir(output, { recursive: true });
    console.log(`Starting isolated SSH host (${rttMs} ms added RTT, ${kbps ? `${kbps} kbps downstream` : 'unlimited downstream'})`);
    const task = await startTaskHost(directory, { rttMs, kbps }, signal, cleanup);
    const viewer = await startViewer(binary, join(directory, 'viewer'), task, signal, cleanup);
    try {
      await verifyApp(viewer, task, signal, screenshot);
    } catch (error) {
      const diagnostic = await viewer.page.evaluate(() => ({
        text: document.body?.innerText.slice(0, 1500),
        tabs: [...document.querySelectorAll('[role=tab]')].map(tab => {
          const box = tab.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            label: tab.getAttribute('aria-label'), inert: !!tab.closest('[inert],[hidden]'),
            box: box.toJSON(), hit: hit?.tagName,
          };
        }),
      })).catch(() => null);
      throw new Error('Packaged Apps smoke failed. ' + JSON.stringify(diagnostic).slice(0, 4000) +
        '\n' + viewer.viewer.diagnostics(), { cause: error });
    }
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = [];
    for (const stop of cleanup.reverse()) {
      try { await stop(); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) { cleanupErrors.push(error); }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (cleanupErrors.length) {
      throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Fixture cleanup failed');
    }
    if (failure) throw failure;
  }
  console.log('Packaged Linux SSH Apps smoke passed. Screenshot ' + screenshot);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
