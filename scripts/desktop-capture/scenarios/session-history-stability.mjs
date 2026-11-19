import assert from 'node:assert/strict';

/** Short collapsed turns must not drain or replace visible replies when paging. */
export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 900 : 1080);
      await capture.theme(theme); await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', async owner => {
        owner.fixture.chat.scenario('new', 101);
        const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
        const base = { timestamp: '2026-11-17T10:00:00Z', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
        const turn = (number) => [
          { ...base, id: `prompt-${number}`, kind: 'user', text: `Request ${number}: keep the conversation stable while paging hidden activity.` },
          ...Array.from({ length: 600 }, (_, i) => ({ ...base, id: `evidence-${number}-${i}`, kind: i % 35 ? 'system' : 'assistant', text: `Progress update ${number}.${i}` })),
          { ...base, id: `answer-${number}`, kind: 'assistant', text: `Finished request ${number}.\n\nThe completed answer stays visible while hidden work is paged out.\n\nValidation passed.` },
        ];
        owner.fixture.chat.seed(101, { state: result.value.state, items: [...turn(1), ...turn(2)] });
      });
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('[data-chat-row="answer-2"]'));
      await capture.fill('ex-composer textarea', 'Keep this draft');
      const probe = await capture.component('ex-session-chat', async owner => {
        const samples = [];
        for (let i = 0; i < 60; i++) {
          await new Promise(requestAnimationFrame);
          const viewport = document.querySelector('ex-chat-scroll .viewport');
          samples.push({ last: owner.store.items().at(-1)?.id, size: owner.store.items().length,
            height: viewport.scrollHeight, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
        }
        return samples;
      });
      assert.ok(probe.every(frame => frame.last === 'answer-2' && frame.size <= 320 && Math.abs(frame.gap) <= 1), 'Opening drained hidden work or dropped end following');
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      yield { name: `${prefix}-short-opening`, inspect: ['ex-chat-scroll', 'ex-composer'], metadata: { probe } };
      // Each physical upward gesture can fetch one older page. Keep the final
      // reply mounted even when several whole turns of work leave the raw window.
      const pages = [];
      for (let i = 0; i < 11; i++) {
        const before = await capture.component('ex-session-chat', owner => owner.store.before());
        if (!before) break;
        const point = await capture.evaluate(() => {
          const rect = document.querySelector('ex-chat-scroll .viewport').getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -60 });
        await capture.waitFor(before => {
          const owner = window.ng.getComponent(document.querySelector('ex-session-chat'));
          return owner.store.before() !== before && !owner.store.historyLoading();
        }, before);
        const page = await capture.component('ex-session-chat', owner => ({ size: owner.store.items().length,
          answer: owner.store.exchanges().at(-1)?.answer, answerId: owner.store.exchanges().at(-1)?.answerId,
          next: owner.store.next(), prompts: owner.store.exchanges().map(exchange => exchange.prompt) }));
        assert.equal(page.answerId, 'answer-2', 'A progress message replaced the finished reply');
        assert.ok(page.size <= 320); pages.push(page);
      }
      assert.ok(pages.at(-1).next, 'The test must evict the raw tail');
      yield { name: `${prefix}-collapsed-eviction`, inspect: ['ex-chat-scroll', 'ex-composer'], metadata: { pages } };
      // Downward intent must fetch following history even if both edges fit in
      // the viewport. Otherwise short conversations keep loading the wrong edge.
      const next = pages.at(-1).next;
      await capture.evaluate(() => { const viewport = document.querySelector('ex-chat-scroll .viewport'); viewport.scrollTop = viewport.scrollHeight; });
      const point = await capture.evaluate(() => { const r = document.querySelector('ex-chat-scroll .viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 60 });
      await capture.waitFor(next => window.ng.getComponent(document.querySelector('ex-session-chat')).store.next() !== next, next);
      assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this draft');
      yield { name: `${prefix}-following-intent`, inspect: ['ex-chat-scroll', 'ex-composer'] };
    }
  }
}
