import assert from 'node:assert/strict';

/** A quiet completion dot clears through actual conversation viewing. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const inspect = ['ex-workspace-navigation', 'ex-session-row [data-session-id="102"]', 'ex-session-chat'];
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      await capture.theme(theme);
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('ex-session-chat textarea'));
      const at = `2026-11-14T12:${theme === 'light' ? '00' : '01'}:${narrow ? '01' : '00'}.000Z`;
      await capture.component('ex-connected-workspace-demo', (c, at) => c.fixture.completeUnseen(102, at), at);
      await capture.component('ex-machine-workspace', c => c.store.refresh());
      await capture.waitFor(() => document.querySelector('[data-session-id="102"] [data-status="review"]'));
      const dot = await capture.evaluate(() => {
        const svg = document.querySelector('[data-session-id="102"] [data-status="review"]');
        const circle = svg.querySelector('circle[fill="currentColor"]');
        return { label: svg.getAttribute('aria-label'), radius: circle.getAttribute('r'),
          width: svg.getBoundingClientRect().width, paths: svg.querySelectorAll('path').length,
          title: document.querySelector('[data-session-id="102"] .title').getBoundingClientRect().x };
      });
      assert.equal(dot.label, 'New reply'); assert.equal(dot.radius, '2.5'); assert.equal(dot.paths, 0);
      assert.equal(dot.width, 14);
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}-unseen`, inspect, metadata: dot };
      // Native keyboard activation uses the same selected-conversation path as a click.
      await capture.evaluate(() => document.querySelector('[data-session-id="102"] button.select').focus());
      await capture.press('Enter');
      await capture.waitFor(() => document.querySelector('[data-session-id="102"] [data-status="done"]'));
      assert.equal(await capture.evaluate(() => document.querySelector('[data-session-id="102"] .title').getBoundingClientRect().x), dot.title);
      const acknowledged = await capture.component('ex-connected-workspace-demo', (c, at) => c.fixture.sentChatActions.filter(input => input.sessionId === 102 && input.action.type === 'mark-seen' && input.action.completionAt === at).length, at);
      assert.equal(acknowledged, 1);
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'desktop'}-viewed`, inspect };
    }
    // Reading an older part of the latest window must not mark a new finish seen.
    await capture.viewport(1440, 900); await capture.reducedMotion(true);
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('history', 101));
    await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length > 5);
    await capture.evaluate(() => {
      const viewport = document.querySelector('ex-chat-scroll .viewport');
      viewport.scrollTop = Math.max(200, viewport.scrollHeight - viewport.clientHeight - 500);
      viewport.dispatchEvent(new window.Event('scroll'));
    });
    const at = `2026-11-14T13:${theme === 'light' ? '00' : '01'}:00.000Z`;
    await capture.component('ex-connected-workspace-demo', (c, at) => c.fixture.completeUnseen(101, at), at);
    await capture.component('ex-machine-workspace', c => c.store.refresh());
    await capture.waitFor(() => document.querySelector('[data-session-id="101"] [data-status="review"]'));
    assert.equal(await capture.component('ex-connected-workspace-demo', (c, at) => c.fixture.sentChatActions.some(input => input.action.type === 'mark-seen' && input.action.completionAt === at), at), false);
    yield { name: `${theme}-reading-earlier-unseen`, inspect };
    await capture.click('ex-chat-scroll .return-button');
    await capture.waitFor(() => document.querySelector('[data-session-id="101"] [data-status="done"]'));
    yield { name: `${theme}-returned-to-latest`, inspect };
  }
}
