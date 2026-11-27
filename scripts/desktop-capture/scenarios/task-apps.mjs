import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const ffmpeg = createRequire(new URL('../../../apps/backend/package.json', import.meta.url))('ffmpeg-static');

// A real video access unit enters the production WebCodecs/display/input boundary.
// The host and machine transport exercise separate native integration tests.
export default async function* (capture) {
  const encode = async size => (await promisify(execFile)(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=' + size + ':rate=1', '-frames:v', '1', '-threads', '1', '-c:v', 'libx264',
    '-profile:v', 'baseline', '-level:v', '4.2', '-preset', 'ultrafast', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1'],
    { encoding: 'buffer', timeout: 10000, maxBuffer: 500000 })).stdout;
  const [stdout, smaller] = await Promise.all([encode('640x400'), encode('320x200')]);
  await capture.evaluate(() => { location.href = '/task-apps'; });
  await capture.waitFor(() => document.querySelector('ex-task-apps-demo'));
  await capture.waitFor(() => !!globalThis.ng?.getComponent(document.querySelector('ex-task-apps-demo'))?.fixture.watchId);
  await capture.viewport(440, 680);
  const app = (fn, ...args) => capture.component('ex-task-apps-demo', fn, ...args);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await app((c, bytes) => c.fixture.deliver(Uint8Array.from(bytes), c.fixture.receipts + 1), [...stdout]);
    await capture.waitFor(() => document.querySelector('ex-app-stream canvas:not([hidden])'));
    await capture.click('ex-app-stream canvas');
    await capture.press('a');
    await capture.press('ArrowLeft');
    await capture.waitFor(() => globalThis.ng.getComponent(document.querySelector('ex-task-apps-demo')).fixture.input.some(event => event.kind === 'key' && event.code === 'ArrowLeft' && !event.down));
    const input = await app(c => c.fixture.input);
    assert.ok(input.some(event => event.kind === 'text' && event.text === 'a'));
    assert.ok(input.some(event => event.kind === 'down' && event.x >= 0 && event.x < 640 && event.y >= 0 && event.y < 400));
    if (theme === 'light') yield { name: 'light-controlling', selector: 'ex-task-apps' };
    await capture.press('Escape', 8);
    await capture.waitFor(() => document.activeElement?.matches('ex-app-stream .viewport'));
    yield { name: theme + '-live', selector: 'ex-task-apps', inspect: ['ex-app-stream canvas', 'ex-task-apps ex-view-tabs', 'ex-app-stream .hint'] };
  }
  const canvasBox = () => capture.evaluate(() => document.querySelector('ex-app-stream canvas').getBoundingClientRect().toJSON());
  const original = await canvasBox();
  await app((c, bytes) => c.fixture.deliver(Uint8Array.from(bytes), c.fixture.receipts + 1, c.fixture.watchId, { width: 320, height: 200 }, true, { width: 640, height: 400 }), [...smaller]);
  await capture.waitFor(() => document.querySelector('ex-app-stream canvas')?.width === 320);
  assert.deepEqual(await canvasBox(), original);
  await capture.click('ex-app-stream canvas');
  const lastDown = await app(c => c.fixture.input.findLast(event => event.kind === 'down'));
  assert.ok(Math.abs(lastDown.x - 320) < 3 && Math.abs(lastDown.y - 200) < 3);
  yield { name: 'dark-lower-resolution', selector: 'ex-task-apps' };
  await capture.press('Escape', 8);
  await capture.reducedMotion(true);
  const old = await app(c => c.fixture.watchId);
  await app(c => c.fixture.interrupt());
  await capture.waitFor(() => document.querySelector('ex-app-stream [role=status]')?.textContent.includes('disconnected'));
  yield { name: 'disconnected', selector: 'ex-task-apps' };
  await capture.click('ex-app-stream .message button');
  await capture.waitFor(id => {
    const next = globalThis.ng.getComponent(document.querySelector('ex-task-apps-demo')).fixture.watchId;
    return next && id !== next;
  }, old);
  await app((c, data) => c.fixture.deliver(Uint8Array.from(data.bytes), 1, data.id), { bytes: [...stdout], id: old });
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-stream canvas').hidden), true);
  await app((c, bytes) => c.fixture.deliver(Uint8Array.from(bytes), 1), [...stdout]);
  await capture.waitFor(() => document.querySelector('ex-app-stream canvas:not([hidden])'));
  await capture.click('ex-task-apps button[aria-label=Logs]');
  await capture.waitFor(() => document.querySelector('ex-task-apps pre')?.textContent.includes('Listening for changes.'));
  yield { name: 'live-with-logs', selector: 'ex-task-apps' };
  await capture.click('ex-task-apps button[aria-label="Stop app"]');
  await capture.waitFor(() => document.querySelector('ex-task-apps h2')?.textContent === 'App exited');
  yield { name: 'exited-with-logs', selector: 'ex-task-apps' };
  await app(c => c.fixture.propose());
  await capture.component('ex-task-apps', component => component.refresh());
  await capture.waitFor(() => document.querySelector('.request .command')?.textContent === 'pnpm run desktop:dev');
  yield { name: 'launch-request', selector: 'ex-task-apps' };
  await capture.click('.request button[data-variant=primary]');
  await capture.waitFor(() => document.querySelector('ex-task-apps h2')?.textContent === 'Starting…');
}
