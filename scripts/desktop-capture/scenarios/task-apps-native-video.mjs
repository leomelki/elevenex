import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A real VideoToolbox keyframe from the native helper's --self-test-window
// 480 352 command, in its 9-byte-header format. Solid black pixels; no user content.
// Repeated access units exercise the decoder's retained-output behavior.
export default async function* (capture) {
  const packet = await readFile(new URL('../../../apps/renderer/preview/fixtures/videotoolbox-window.bin', import.meta.url));
  assert.equal(packet.readUInt32BE(), packet.length - 9);
  const video = { bytes: [...packet.subarray(9)], width: packet.readUInt16BE(4), height: packet.readUInt16BE(6) };
  await capture.evaluate(() => { location.href = '/task-apps'; });
  await capture.waitFor(() => {
    const element = document.querySelector('ex-task-apps-demo');
    return element && globalThis.ng?.getComponent(element)?.fixture.watchId;
  });
  await capture.viewport(440, 680);
  const timer = await capture.component('ex-task-apps-demo', (component, video) => {
    let watch = '', sequence = 0;
    return window.setInterval(() => {
      const current = component.fixture.watchId;
      if (!current) return;
      if (current !== watch) { watch = current; sequence = 0; }
      component.fixture.deliver(Uint8Array.from(video.bytes), ++sequence, current, { width: video.width, height: video.height });
    }, 100);
  }, video);
  try {
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await capture.waitFor(() => globalThis.ng.getComponent(document.querySelector('ex-task-apps-demo')).fixture.receipts >= 5);
      await capture.waitFor(() => !document.querySelector('ex-app-stream canvas').hidden);
      yield { name: theme + '-native-video', selector: 'ex-task-apps', inspect: ['ex-app-stream canvas', 'ex-app-stream .hint'] };
    }
    await capture.evaluate(id => window.clearInterval(id), timer);
    await capture.component('ex-task-apps-demo', component => component.fixture.interrupt('The app display was interrupted.'));
    await capture.waitFor(() => document.querySelector('ex-app-stream .message')?.textContent.includes("couldn't decode or draw"));
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      yield { name: theme + '-local-decode-failure', selector: 'ex-task-apps', inspect: ['ex-app-stream .message'] };
    }
  } finally { await capture.evaluate(id => window.clearInterval(id), timer); }
}
