import assert from 'node:assert/strict';
import { clipboard, ClipboardItem } from 'electron';

/** Production copy owners + real preload/native clipboard; backend data is preview-only. */
export default async function* (capture) {
  const savedClipboard = await Promise.all((await clipboard.read()).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  const nativeWrite = clipboard.writeText;
  const text = '  café 👩🏽‍💻\n\t代码\n';
  const readText = async () => (await clipboard.readText()).replaceAll('\r\n', '\n');
  const codeButton = 'ex-session-chat ex-markdown-code button';
  try {
    await capture.evaluate(() => { location.href = '/connected-workspace'; });
    await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('ex-session-chat ex-turn .answer'));
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await capture.viewport(1440, 960);
      await capture.reducedMotion(false);
      await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('ready'));
      await capture.waitFor(() => document.querySelector('ex-turn button[aria-label="Copy reply (C)"]'));
      await capture.settle();
      const answer = await capture.component('ex-session-chat', c => c.store.exchanges().at(-1).answer);
      await capture.component('ex-session-chat', c => c.store.notice.set(''));
      await capture.evaluate(() => document.querySelector('ex-turn button[aria-label="Copy reply (C)"]').scrollIntoView({ block: 'center' }));
      await capture.click('ex-turn button[aria-label="Copy reply (C)"]');
      await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-session-chat')).store.notice() === 'Copied');
      assert.equal(await readText(), answer.replaceAll('\r\n', '\n'));
      yield { name: `${theme}-reply-copied`, inspect: ['ex-turn-acts', 'ex-session-chat .feedback'] };

      const code = await capture.evaluate(() => document.querySelector('ex-session-chat ex-markdown-code code').textContent);
      await capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), codeButton);
      await capture.click(codeButton);
      await capture.waitFor(() => document.querySelector('ex-markdown-code button')?.getAttribute('aria-label') === 'Code copied');
      assert.equal(await readText(), code.replaceAll('\r\n', '\n'));
      yield { name: `${theme}-code-copied`, inspect: ['ex-markdown-code'] };

      await capture.hover('ex-branch-chip');
      await capture.click('ex-branch-chip button.copy');
      await capture.waitFor(() => document.querySelector('ex-branch-chip button.copy')?.getAttribute('aria-label') === 'Copied');
      assert.equal(await readText(), 'fix/idempotent-retries');
      yield { name: `${theme}-branch-copied`, inspect: ['ex-branch-chip'] };

      // Same shared chat copy owner, reached from the bounded original-content reader.
      await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('long-message'));
      await capture.waitFor(() => [...document.querySelectorAll('ex-chat button')].some(b => b.textContent.includes('Read full message')));
      await capture.evaluate(() => document.querySelector('ex-chat-scroll > .viewport > .content > button:last-of-type').scrollIntoView({ block: 'center' }));
      await capture.click('ex-chat-scroll > .viewport > .content > button:last-of-type');
      await capture.waitFor(() => document.querySelector('[aria-label="Full transcript content"] pre'));
      const page = await capture.evaluate(() => document.querySelector('[aria-label="Full transcript content"] pre').textContent);
      await capture.component('ex-session-chat', c => c.store.notice.set(''));
      await capture.evaluate(() => [...document.querySelectorAll('[aria-label="Full transcript content"] button')].find(b => b.textContent.includes('Copy page')).focus());
      await capture.press('Enter');
      await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-session-chat')).store.notice() === 'Copied');
      assert.equal(await readText(), page.replaceAll('\r\n', '\n'));
      yield { name: `${theme}-page-copied`, inspect: ['[aria-label="Full transcript content"]'] };
      await capture.press('Escape');
      await capture.waitFor(() => !document.querySelector('ex-session-chat-content'));

      await capture.viewport(1000, 760); await capture.reducedMotion(true);
      await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('ready'));
      await capture.waitFor(() => document.querySelector('ex-session-chat ex-markdown-code'));
      // Exercise the failure and retry path without changing browser permissions.
      clipboard.writeText = async () => { throw new Error('Clipboard temporarily unavailable'); };
      await capture.component('ex-session-chat', (c, value) => c.copy(value), text);
      await capture.waitFor(() => document.querySelector('ex-session-chat .feedback.error')?.textContent.includes('Could not copy'));
      yield { name: `${theme}-copy-failed`, inspect: ['ex-session-chat .feedback.error'] };
      clipboard.writeText = nativeWrite;
      await capture.component('ex-session-chat', (c, value) => c.copy(value), text);
      await capture.waitFor(() => !document.querySelector('ex-session-chat .feedback.error'));
      assert.equal(await readText(), text);
      assert.equal(await capture.component('ex-session-chat', c => c.store.notice()), 'Copied');
      yield { name: `${theme}-retry-narrow-reduced`, inspect: ['ex-session-chat', 'ex-session-chat .feedback'] };
    }
  } finally {
    clipboard.writeText = nativeWrite;
    await clipboard.write(savedClipboard);
  }
}
