import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Real selected files through the production composer; backend replies are preview-only. */
export default async function* (capture) {
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-chat-files-'));
  try {
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    const mode = () => capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('ready'));
    const image = await capture.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#e7f4f1'; ctx.fillRect(0, 0, 800, 450);
      ctx.fillStyle = '#123c37'; ctx.font = '600 40px sans-serif'; ctx.fillText('A calmer workspace', 54, 90);
      ctx.fillStyle = '#36796d'; ctx.font = '22px sans-serif'; ctx.fillText('Early direction · November 2026', 54, 132);
      for (let i = 0; i < 3; i++) { ctx.fillStyle = ['#a6d8c7', '#68b49c', '#23856c'][i]; ctx.beginPath(); ctx.roundRect(54 + i * 235, 190, 210, 198, 16); ctx.fill(); }
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const video = await capture.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#174b43'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#d8f2e8'; ctx.font = '32px sans-serif'; ctx.fillText('Workspace walkthrough', 60, 180);
      const stream = canvas.captureStream(6), chunks = [];
      const recorder = new window.MediaRecorder(stream, { mimeType: 'video/webm' });
      const blob = await new Promise(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = () => resolve(new window.Blob(chunks, { type: 'video/webm' })); recorder.start(); let frame = 0; const timer = window.setInterval(() => { ctx.fillStyle = '#3fd2c3'; ctx.fillRect(60, 240, ++frame * 42, 6); }, 60); setTimeout(() => { window.clearInterval(timer); recorder.stop(); }, 600); });
      for (const track of stream.getTracks()) track.stop();
      return await new Promise(resolve => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
    });
    const png = join(directory, 'workspace-direction.png'), clip = join(directory, 'walkthrough.webm'), notes = join(directory, 'review-notes.txt');
    await writeFile(png, Buffer.from(image, 'base64')); await writeFile(clip, Buffer.from(video, 'base64')); await writeFile(notes, 'Compare the spacing and motion in the attached direction.');
    const settledComposer = () => capture.waitFor(() => [...document.querySelector('ex-composer').getAnimations({ subtree: true })].every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    const control = async selector => { await settledComposer(); await capture.click(selector); };
    const choose = async files => {
      await settledComposer();
      await capture.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
      await capture.click('ex-composer button[aria-label^="Attach files"]');
      const { root } = await capture.cdp('DOM.getDocument');
      const { nodeId } = await capture.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: 'ex-composer input[type="file"]' });
      await capture.cdp('DOM.setFileInputFiles', { nodeId, files });
      await capture.cdp('Page.setInterceptFileChooserDialog', { enabled: false });
    };
    for (const theme of ['light', 'dark']) {
      await capture.viewport(1440, 960); await capture.theme(theme); await mode();
      await capture.waitFor(() => document.querySelector('ex-composer button[aria-label^="Attach files"]')?.disabled === false);
      await capture.fill('ex-composer textarea', 'Compare this direction with the walkthrough. Use the review notes for context.');
      await choose([png, clip, notes]);
      await capture.waitFor(() => document.querySelectorAll('ex-composer .attachment').length === 3 && !document.querySelector('ex-composer progress, ex-composer .attachment.failed'));
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-composer .attachment')].every(card => card.getBoundingClientRect().height <= 40)), true, 'Ready draft chips should fit one compact row');
      yield { name: `${theme}-selected-files`, inspect: ['ex-composer', 'ex-composer .attachment', 'ex-composer .bar'] };
      // Native keyboard submission, with ready image/video/file cards in the transcript.
      await capture.click('ex-composer textarea'); await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('ex-message.user video')?.readyState >= 2 && document.querySelector('ex-message.user img')?.naturalWidth > 0);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-message.user video').autoplay), false);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-message.user video').controls), true);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-message.user video').getAttribute('aria-label')), 'walkthrough.webm');
      await capture.evaluate(() => document.querySelector('ex-message.user:has(video)').scrollIntoView({ block: 'center', behavior: 'instant' }));
      assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-message.user .media')].every(card => card.getBoundingClientRect().height <= 180)), true, 'Sent previews should remain compact');
      await capture.evaluate(() => document.querySelector('ex-message.user video').focus());
      for (const type of ['keyDown', 'keyUp']) await capture.cdp('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, ...(type === 'keyDown' ? { text: ' ' } : {}) });
      await capture.waitFor(() => document.querySelector('ex-message.user video')?.currentTime > 0);
      await capture.evaluate(async () => {
        const video = document.querySelector('ex-message.user video');
        video.pause();
        await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 0; });
      });
      await capture.settle();
      yield { name: `${theme}-sent-media`, inspect: ['ex-message.user', 'ex-message.user video', 'ex-message.user .attachments'] };
      await capture.click('ex-message.user button[aria-label^="Enlarge"]');
      await capture.waitFor(() => document.querySelector('dialog[open] img'));
      yield { name: `${theme}-image-viewer`, inspect: ['dialog[open]'] };
      await capture.press('Escape');
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Enlarge')), true);
      // A failed upload stays removable/retryable and cannot be sent.
      await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.uploadState = 'failed'; });
      await choose([notes]);
      await capture.waitFor(() => document.querySelector('ex-composer .attachment.failed'));
      assert.equal(await capture.evaluate(() => document.querySelector('ex-composer button.send').disabled), true);
      yield { name: `${theme}-upload-failed`, inspect: ['ex-composer', 'ex-composer .attachment.failed'] };
      await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.uploadState = 'ready'; });
      await control('ex-composer ex-attachments button[exbutton]');
      await capture.waitFor(() => document.querySelector('ex-composer .attachment') && !document.querySelector('ex-composer progress, ex-composer .attachment.failed'));
      await control('ex-composer button[aria-label="Remove review-notes.txt"]');
      assert.equal(await capture.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
      // DOM file transfer exercises the same scoped paste/drop handlers without changing the OS clipboard.
      await capture.evaluate(() => {
        const transfer = new window.DataTransfer(); transfer.items.add(new window.File(['pasted notes'], 'pasted.txt', { type: 'text/plain' }));
        document.querySelector('ex-composer textarea').dispatchEvent(new window.ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
      });
      await capture.waitFor(() => document.querySelector('ex-composer .attachment') && !document.querySelector('ex-composer progress, ex-composer .attachment.failed'));
      await control('ex-composer button[aria-label="Remove pasted.txt"]');
      await capture.evaluate(() => {
        const transfer = new window.DataTransfer(); transfer.items.add(new window.File(['dropped notes'], 'dropped.txt'));
        document.querySelector('ex-chat').dispatchEvent(new window.DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      });
      await capture.waitFor(() => document.querySelector('ex-composer .attachment') && !document.querySelector('ex-composer progress, ex-composer .attachment.failed'));
      await capture.viewport(780, 850); await capture.reducedMotion(true); await capture.settle();
      yield { name: `${theme}-narrow-files`, inspect: ['ex-composer', 'ex-composer .bar', 'ex-composer .attachment'] };
      await control('ex-composer button[aria-label="Remove dropped.txt"]');
      await capture.reducedMotion(false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
