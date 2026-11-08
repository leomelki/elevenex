import assert from 'node:assert/strict';

/** HTTP read failures must not look like failed sends or disturb ongoing work. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => {
    component.store.selectSession({ taskId: '11', sessionId: '101' });
  });
  await capture.waitFor(() => {
    const chat = document.querySelector('ex-session-chat');
    return chat && window.ng.getComponent(chat).store.state();
  });
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const mode of ['history', 'running']) {
      const narrow = mode === 'running';
      await capture.viewport(narrow ? 980 : 1440, 900);
      await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', (demo, mode) => {
        demo.fixture.chat.scenario(mode, 101);
      }, mode);
      await capture.component('ex-session-chat', async component => { await component.store.refresh(); });
      await capture.fill('ex-composer textarea', 'Keep this draft while the backend recovers');
      await capture.waitFor(() => document.getAnimations().every(animation =>
        !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
      await capture.component('ex-session-chat', component => { component.store.setActive(false); });
      const probe = await capture.evaluate(async () => {
        const fixture = window.ng.getComponent(document.querySelector('ex-connected-workspace-demo')).fixture;
        const chat = document.querySelector('ex-session-chat');
        const store = window.ng.getComponent(chat).store;
        const original = fixture.sessionChatRead;
        const composer = chat.querySelector('textarea');
        const viewport = chat.querySelector('ex-chat-scroll .viewport');
        const mounted = [...chat.querySelectorAll('ex-turn')];
        const box = composer.getBoundingClientRect(), scrollTop = viewport.scrollTop;
        const selection = [composer.selectionStart, composer.selectionEnd];
        const violations = new Set();
        let attempts = 0, frames = 0;
        fixture.sessionChatRead = async () => {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 80));
          return { ok: false, error: { code: 'http', status: 503, message: 'Backend request failed.' } };
        };
        try {
          store.setActive(true);
          const start = performance.now();
          do {
            await new Promise(requestAnimationFrame); frames++;
            if (store.loading()) violations.add('loading flash');
            if (store.error() || chat.textContent.includes('Backend request failed.')) violations.add('error banner');
            if (mounted.some(element => !element.isConnected)) violations.add('remounted turn');
            if (viewport.scrollTop !== scrollTop) violations.add('scroll moved');
            if (document.activeElement !== composer || composer.value !== 'Keep this draft while the backend recovers' ||
              composer.selectionStart !== selection[0] || composer.selectionEnd !== selection[1]) violations.add('draft or focus changed');
            const next = composer.getBoundingClientRect();
            if (['x', 'y', 'width', 'height'].some(key => Math.abs(next[key] - box[key]) > 0.5)) violations.add('composer moved');
          } while (performance.now() - start < 3400);
          return { attempts, frames, violations: [...violations] };
        } finally {
          fixture.sessionChatRead = original;
        }
      });
      assert.ok(probe.attempts >= 2, JSON.stringify(probe));
      assert.ok(probe.frames > 10);
      assert.deepEqual(probe.violations, []);
      yield { name: `${theme}-${mode}-http-failures`, inspect: ['ex-session-chat', 'ex-composer'], metadata: probe };
      await capture.component('ex-connected-workspace-demo', (demo, mode) => { demo.fixture.chat.scenario(mode, 101); }, mode);
      await capture.component('ex-session-chat', async component => { await component.store.refresh(); });
      const recovered = await capture.component('ex-session-chat', component => ({
        error: component.store.error(), draft: component.store.draft(), items: component.store.items().length,
      }));
      assert.equal(recovered.error, '');
      assert.equal(recovered.draft, 'Keep this draft while the backend recovers');
      assert.ok(recovered.items > 0);
      yield { name: `${theme}-${mode}-recovered`, inspect: ['ex-session-chat', 'ex-composer'] };
    }
  }
}
