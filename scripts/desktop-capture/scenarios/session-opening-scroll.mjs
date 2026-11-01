import assert from 'node:assert/strict';

/** Opening history starts at its tail on the first rendered frame. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', component => {
    component.fixture.chat.scenario('history', 101);
    component.fixture.chat.scenario('history', 102);
  });
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
                  height: viewport.scrollHeight, viewport: viewport.clientHeight, frames });
              } else if (++frames > 180) reject(new Error('Session history did not render'));
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        }, sessionId);
        assert.ok(probe.height > probe.viewport, 'History must overflow for a meaningful scroll check');
        assert.ok(Math.abs(probe.gap) <= 1, JSON.stringify(probe));
      }
      yield { name: `${theme}-${narrow ? 'narrow-reduced' : 'full'}-opened-at-end`,
        inspect: ['ex-chat-scroll .viewport', 'ex-turn:last-of-type', 'ex-composer'] };
      await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop = 100;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      await capture.component('ex-session-chat', component => component.store.refresh());
      assert.equal(await capture.evaluate(() => document.querySelector('ex-chat-scroll .viewport').scrollTop), 100);
    }
  }
}
