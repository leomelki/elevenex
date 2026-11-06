import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BrowserWindow } from 'electron';

const backendRequire = createRequire(new URL('../../../apps/backend/package.json', import.meta.url));
const ffmpeg = backendRequire('ffmpeg-static');

async function encode(jpeg) {
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
    '-frames:v', '1', '-c:v', 'libx264', '-threads', '1', '-profile:v', 'baseline', '-level:v', '4.2',
    '-pix_fmt', 'yuv420p', '-tune', 'zerolatency', '-f', 'h264', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 3000000) child.kill(); else chunks.push(chunk); });
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  child.stdin.end(jpeg);
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fixture encode failed'))); });
    return [...Buffer.concat(chunks)];
  } finally { clearTimeout(timer); child.kill(); }
}

// Actual Electron page pixels and FFmpeg access units; the stream component and
// trusted DOM input are real. Transport/host input have separate integration tests.
export default async function* (capture) {
  const source = new BrowserWindow({ show: false, width: 800, height: 600, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  try {
    await source.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>:root{color-scheme:light dark}body{font:18px system-ui;margin:40px}input,button{font:inherit;padding:12px}p{line-height:1.6}</style>
      <h1>Task browser</h1><p>A real Chromium page, encoded as H.264 and decoded in the renderer.</p>
      <label>Search <input placeholder="Type here"></label><p><button>Continue</button></p>`));
    await capture.evaluate(() => { location.href = '/browser-video'; });
    await capture.waitFor(() => document.querySelector('ex-browser-stream canvas'));
    await capture.viewport(1000, 780);
    let sequence = 0;
    const streamId = randomUUID();
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      const data = await encode((await source.webContents.capturePage()).toJPEG(90));
      const packet = { scopeId: 'preview', taskId: 1, tabId: 'video-tab', streamId, sequence: ++sequence,
        width: 800, height: 600, jpeg: [], video: { epoch: randomUUID(), codec: 'avc1.42E02A', key: true, timestamp: sequence * 33333, data } };
      await capture.component('ex-browser-video-demo', (component, frame) => component.fixture.deliver({ ...frame, jpeg: new Uint8Array(), video: { ...frame.video, data: new Uint8Array(frame.video.data) } }), packet);
      await capture.waitFor(() => !document.querySelector('ex-browser-stream [role="status"]'));
      const receipt = await capture.component('ex-browser-video-demo', component => component.fixture.acknowledgments.at(-1));
      assert.equal(receipt.decoded, true, 'Real H.264 decoded and displayed');
      await capture.click('ex-browser-stream canvas');
      await capture.press('z', 4);
      await capture.cdp('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
      await capture.cdp('Input.insertText', { text: '日本語' });
      const inputs = await capture.component('ex-browser-video-demo', component => component.fixture.inputs.flatMap(input => input.kind === 'batch' ? input.events : [input]));
      assert.ok(inputs.some(input => input.kind === 'edit' && input.operation === 'undo'));
      assert.ok(inputs.some(input => input.kind === 'composition' && input.text === 'に'));
      assert.equal(inputs.filter(input => input.kind === 'text' && input.text === '日本語').length, theme === 'light' ? 1 : 2);
      yield { name: `${theme}-h264-input`, selector: 'ex-browser-video-demo', inspect: ['canvas', 'textarea'] };
    }
    await capture.reducedMotion(true);
    await capture.viewport(440, 760);
    yield { name: 'narrow-reduced-motion', selector: 'ex-browser-video-demo', inspect: ['canvas', 'textarea'] };
    await capture.component('ex-browser-video-demo', component => component.surface.update(surface => ({ ...surface, visible: false })));
    await capture.waitFor(() => document.querySelector('ex-browser-stream [role="status"]')?.textContent.includes('paused'));
    yield { name: 'display-paused', selector: 'ex-browser-video-demo' };
  } finally { source.destroy(); }
}
