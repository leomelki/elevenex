import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// ScreenCaptureKit and VideoToolbox captured a test window that changes solid
// colors. Each access unit retains its nine-byte native helper header.
export default async function* (capture) {
  const data = await readFile(new URL('../../../apps/renderer/preview/fixtures/videotoolbox-window.bin', import.meta.url));
  const packets = [];
  for (let offset = 0; offset < data.length;) {
    const size = data.readUInt32BE(offset);
    const end = offset + 9 + size;
    assert.ok(size && end <= data.length);
    packets.push({
      bytes: [...data.subarray(offset + 9, end)],
      width: data.readUInt16BE(offset + 4), height: data.readUInt16BE(offset + 6),
      key: data[offset + 8] === 1,
    });
    offset = end;
  }
  assert.ok(packets[0]?.key && packets.slice(1).every(packet => !packet.key));
  assert.ok(packets.length > 8, 'The delta chain must exceed the viewer queue depth');

  await capture.evaluate(() => { location.href = '/task-apps'; });
  await capture.waitFor(() => {
    const element = document.querySelector('ex-task-apps-demo');
    return element && globalThis.ng?.getComponent(element)?.fixture.watchId;
  });
  await capture.viewport(440, 680);
  await capture.reducedMotion(true);

  let sequence = 0;
  const deliver = async (batch, expectedReceipt) => {
    await capture.component('ex-task-apps-demo', async (component, { batch, sequence }) => {
      const watch = component.fixture.watchId;
      for (const { bytes, width, height, key } of batch) {
        component.fixture.deliver(Uint8Array.from(bytes), ++sequence, watch, { width, height }, key);
        await new Promise(resolve => window.setTimeout(resolve, 33));
      }
    }, { batch, sequence });
    sequence += batch.length;
    await capture.waitFor(expected => {
      const message = document.querySelector('ex-app-stream .message strong')?.textContent;
      if (message === 'The picture stopped' || message === 'The picture fell behind') throw new Error(document.querySelector('ex-app-stream .message').textContent);
      const demo = globalThis.ng.getComponent(document.querySelector('ex-task-apps-demo'));
      return demo.fixture.receipts >= expected && !document.querySelector('ex-app-stream canvas').hidden;
    }, expectedReceipt ?? sequence);
  };
  const pixel = () => capture.evaluate(() => {
    const canvas = document.querySelector('ex-app-stream canvas');
    return [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
  });

  const key = packets[0];
  await deliver([key, key, key], 2);
  const firstPicture = await pixel();
  // Stop mid-GOP. A decoder holding these frames used to discard the picture
  // when the two-second deadline expired, even though the app was just idle.
  await deliver(packets.slice(0, 4));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await deliver(packets);
    const movingPicture = await pixel();
    assert.notDeepEqual(movingPicture, firstPicture);
    // Wait beyond the decoder's output deadline. The last picture must stay
    // visible after the host goes idle, then a sparse refresh must paint alone.
    await delay(2300);
    assert.deepEqual(await pixel(), movingPicture);
    await deliver([key]);
    assert.deepEqual(await pixel(), firstPicture);
    yield { name: theme + '-native-video', selector: 'ex-task-apps', inspect: ['ex-app-stream canvas', 'ex-app-stream .hint'] };
  }

  await capture.component('ex-task-apps-demo', component => component.fixture.interrupt('The app display was interrupted.'));
  await capture.waitFor(() => document.querySelector('ex-app-stream .message')?.textContent.includes("couldn't decode or draw"));
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    yield { name: theme + '-local-decode-failure', selector: 'ex-task-apps', inspect: ['ex-app-stream .message'] };
  }
}
