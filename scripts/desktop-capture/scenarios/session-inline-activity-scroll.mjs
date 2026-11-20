import assert from 'node:assert/strict';

const viewport = 'ex-session-chat ex-chat-scroll .viewport';
const worked = 'ex-session-chat ex-turn .work';
const section = '[data-chat-row="call-150"] .group';
const tool = '[data-chat-row="call-150"] ex-tool-step .head';
const checks = [viewport, worked, section, tool];

export default async function* (capture) {
  const demo = fn => capture.component('ex-connected-workspace-demo', fn);
  const chat = fn => capture.component('ex-session-chat', fn);
  const top = selector => capture.evaluate(selector => document.querySelector(selector).getBoundingClientRect().top, selector);
  const settleMotion = () => capture.waitFor(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime)));
  const reveal = async (selector, block = 'center') => {
    await capture.evaluate((selector, block) => document.querySelector(selector).scrollIntoView({ block }), selector, block);
    await capture.settle();
  };
  const wheel = async deltaY => {
    const point = await capture.evaluate(selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, viewport);
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await capture.settle();
  };

  for (const theme of ['light', 'dark']) {
    await capture.evaluate(theme => { location.href = '/connected-workspace?chatLoading=window&inline=' + theme; }, theme);
    await capture.waitFor(theme => location.search === '?chatLoading=window&inline=' + theme &&
      document.querySelector('ex-machine-workspace ex-task-list'), theme);
    await capture.theme(theme);
    await capture.viewport(theme === 'light' ? 1260 : 850, 800);
    await capture.reducedMotion(theme === 'dark');
    await demo(async owner => {
      const fixture = owner.fixture.chat;
      fixture.scenario('new', 101);
      const initial = await fixture.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
      const row = (id, kind, text, extra) => ({
        id, kind, text, timestamp: '2026-11-19T10:00:00Z',
        toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
      });
      const items = [row('request', 'user', 'Review the transcript of this long-running task.')];
      for (let n = 0; n < 180; n++) {
        items.push(row('call-' + n, 'tool_use', '', {
          toolId: 'check-' + n, toolName: 'Command', toolKind: 'bash', input: JSON.stringify({ command: 'pnpm test' }),
        }), row('result-' + n, 'tool_result', 'The command reported its result.', { toolId: 'check-' + n, error: n % 3 === 0 }));
        if ((n + 1) % 30 === 0) items.push(row('reply-' + n, 'assistant',
          ('I checked the saved session and reviewed the tool output. The transcript should stay readable while browsing this activity.\n\n').repeat(5)));
      }
      fixture.seed(101, { items, state: { ...initial.value.state, providerLocked: true } });
    });
    await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelector('[data-chat-row="reply-179"]'));
    assert.equal(await chat(owner => owner.store.progressiveLoading()), false);
    const counts = await capture.evaluate(selector => document.querySelector(selector).textContent, worked);
    const head = await chat(owner => owner.store.items()[0].id);

    await reveal(worked, 'nearest');
    const buttonTop = await top(worked);
    await capture.click(worked);
    await settleMotion();
    assert.ok(Math.abs(await top(worked) - buttonTop) <= 1, 'Worked moved as the inline activity opened');

    await capture.evaluate(selector => { document.querySelector(selector).scrollTop = 0; }, viewport);
    await capture.settle();
    await demo(owner => owner.fixture.chat.holdReads(true));
    await wheel(80);
    assert.equal(await chat(owner => owner.store.historyLoading()), false, 'Scrolling down started an older-page read');
    await wheel(-100);
    await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-session-chat')).store.historyLoading());
    await wheel(65);
    await capture.waitFor(() => !window.ng.getComponent(document.querySelector('ex-session-chat')).store.historyLoading());
    await demo(owner => owner.fixture.chat.holdReads(false));
    assert.equal(await chat(owner => owner.store.items()[0].id), head, 'A reversed scroll replaced the history window');
    assert.equal(await capture.evaluate(selector => document.querySelector(selector).textContent, worked), counts);
    yield { name: theme + '-inline-activity-after-scroll-reversal', inspect: checks };

    await reveal(section);
    const sectionTop = await top(section);
    await capture.click(section);
    await settleMotion();
    assert.ok(Math.abs(await top(section) - sectionTop) <= 1, 'The activity summary moved when expanded');
    await reveal(tool);
    await capture.evaluate(selector => document.querySelector(selector).focus({ preventScroll: true }), tool);
    const toolTop = await top(tool);
    await capture.press('Enter');
    await settleMotion();
    assert.ok(Math.abs(await top(tool) - toolTop) <= 1, 'The tool header moved while its evidence opened');
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), tool), true);
    await capture.waitFor(() => document.querySelector('[data-chat-row="call-150"] .tool-preview')
      ?.textContent.includes('The command reported its result.'));
    yield { name: theme + '-inspecting-inline-evidence', inspect: checks };
    await capture.press('Enter');
    await capture.waitFor(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'false', tool);
    await settleMotion();
    assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), tool), true);
  }
}
