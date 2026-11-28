import assert from 'node:assert/strict';

const demo = 'ex-connected-workspace-demo';
const viewport = 'ex-session-chat ex-chat-scroll .viewport';
const summary = '[data-chat-anchor="prompt:reply"] .group-fold:not([inert]) .group';
const reply = '[data-chat-row="progress"]';
const row = (id, kind, text, extra = {}) => ({
  id, kind, text, timestamp: '2026-11-28T10:00:00Z', toolId: null,
  toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
});
const completedCall = id => row(id, 'tool_use', '', {
  toolId: id, toolKind: 'bash', toolName: 'Command', receipt: { id: id + '-result', error: false },
});

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(theme => {
      location.href = '/connected-workspace?chatLoading=window&theme=' + theme;
    }, theme);
    await capture.waitFor(theme => location.search.endsWith('theme=' + theme) &&
      document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.theme(theme);
    await capture.viewport(theme === 'light' ? 1260 : 760, 760);
    await capture.reducedMotion(theme === 'dark');
    const state = await capture.component(demo, async owner => {
      owner.fixture.chat.scenario('new', 101);
      const { value } = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      return { ...value.state, provider: 'codex', phase: 'running', canInterrupt: true, activePromptId: 'prompt' };
    });
    const items = [row('prompt', 'user', 'Verify the build and record the results.'),
      ...Array.from({ length: 317 }, (_, i) => completedCall('command-' + i)),
      row('progress', 'assistant', ('The focused checks passed. I am reviewing the build output and recording the results.\n\n').repeat(24)),
      row('running', 'tool_use', '', { toolId: 'running', toolKind: 'bash', toolName: 'Command' })];
    const seed = () => capture.component(demo, (owner, page) => owner.fixture.chat.seed(101, page), { state, items });
    await seed();
    await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(selector => document.querySelector(selector)?.getAttribute('aria-label') ===
      'Show activity: 317 commands', summary);
    await capture.evaluate((viewport, summary) => {
      const view = document.querySelector(viewport);
      const button = document.querySelector(summary);
      view.scrollTop += button.getBoundingClientRect().top - view.getBoundingClientRect().top - 44;
      button.focus({ preventScroll: true });
      button.setAttribute('data-captured-summary', '');
    }, viewport, summary);
    await capture.settle();
    const position = () => capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, reply);
    const before = await position();

    for (let n = 1; n <= 3; n++) {
      items.push(completedCall('arriving-' + n * 2), completedCall('arriving-' + (n * 2 + 1)));
      await seed();
      const expected = 317 - (n * 2 - 1);
      await capture.waitFor((selector, expected) => document.querySelector(selector)?.getAttribute('aria-label') ===
        'Show activity: ' + expected + ' commands', summary, expected);
      await capture.settle();
      const actual = await capture.evaluate(selector => {
        const button = document.querySelector(selector);
        return {
          mounted: button.hasAttribute('data-captured-summary'),
          focused: button === document.activeElement,
          visible: !button.closest('[inert]') && button.getBoundingClientRect().height > 0,
          expanded: button.getAttribute('aria-expanded'),
        };
      }, summary);
      assert.deepEqual(actual, { mounted: true, focused: true, visible: true, expanded: 'false' });
      assert.ok(Math.abs(await position() - before) <= 1, 'Live window trimming moved the reply in the viewport');
    }
    yield { name: theme + '-collapsed-summary-after-live-window-trims', inspect: [viewport, summary, reply] };
  }
}
