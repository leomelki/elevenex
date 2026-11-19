import assert from 'node:assert/strict';

/** The default progressive page starts at the tail on its first rendered frame. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => {
    component.fixture.chat.scenario('history', 101);
    component.fixture.chat.scenario('history', 102);
  });
  // Session 101 may already be cached. Verify the untouched session's first
  // page separately from later openings of windows expanded during browsing.
  let coldOpen = true;
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const narrow of [false, true]) {
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await capture.component('ex-machine-workspace', component => {
        component.store.selectSession({ taskId: '11', sessionId: '101' });
      });
      for (const sessionId of ['102', '101', '102']) {
        const probe = await capture.component('ex-machine-workspace', async (component, sessionId) => {
          const viewport = document.querySelector('ex-chat-scroll .viewport');
          if (viewport) {
            viewport.scrollTop = 0;
            viewport.dispatchEvent(new window.Event('scroll'));
          }
          component.store.selectSession({ taskId: '11', sessionId });
          window.ng.applyChanges(component);
          return await new Promise((resolve, reject) => {
            let frames = 0;
            const check = () => {
              const chat = document.querySelector('ex-session-chat');
              const owner = chat && window.ng.getComponent(chat);
              const viewport = chat?.querySelector('ex-chat-scroll .viewport');
              if (owner?.selection().sessionId === Number(sessionId) &&
                  !owner.store.loading() && owner.store.items().length && viewport) {
                resolve({ gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                  height: viewport.scrollHeight, viewport: viewport.clientHeight, frames,
                  progressive: owner.store.progressiveLoading(), records: owner.store.items().length });
              } else if (++frames > 180) reject(new Error('Session history did not render'));
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        }, sessionId);
        assert.ok(probe.height > probe.viewport, 'History must overflow for a meaningful scroll check');
        assert.ok(Math.abs(probe.gap) <= 1, JSON.stringify(probe));
        assert.equal(probe.progressive, true);
        assert.ok(probe.records <= 320);
        if (coldOpen) assert.equal(probe.records, 80);
        coldOpen = false;
      }
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'full'}-opened-at-end`,
        inspect: ['ex-chat-scroll .viewport', 'ex-turn:last-of-type', 'ex-composer'] };
      await capture.component('ex-session-chat', component => {
        if (component.store.items().length < 160) return component.store.older();
      });
      await capture.waitFor(() => !document.querySelector('.viewport.reconciling-history'));
      const anchor = await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop = 100;
        viewport.dispatchEvent(new window.Event('scroll'));
        const row = [...viewport.querySelectorAll('[data-chat-anchor]')]
          .find(row => row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
        return { id: row.getAttribute('data-chat-anchor'), top: row.getBoundingClientRect().top };
      });
      await capture.component('ex-session-chat', component => component.store.refresh());
      // Edge prefetch can legitimately increase scrollTop by an entire page.
      // The reader's content must retain its screen position through refresh.
      const top = await capture.evaluate(id => [...document.querySelectorAll('[data-chat-anchor]')]
        .find(row => row.getAttribute('data-chat-anchor') === id)?.getBoundingClientRect().top, anchor.id);
      assert.ok(top !== undefined && Math.abs(top - anchor.top) < 2,
        `Refresh moved ${anchor.id} from ${anchor.top}px to ${top ?? 'outside the window'}`);
    }
  }
}
