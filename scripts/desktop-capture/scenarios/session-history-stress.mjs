import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Long turns, bounded eviction, held transport and optional recorded sessions. */
export default async function* (capture) {
  const recorded = process.env.ELEVENEX_SESSION_CAPTURE_PAGES
    ? JSON.parse(await readFile(process.env.ELEVENEX_SESSION_CAPTURE_PAGES, 'utf8')) : [];
  const chat = (fn, value) => capture.component('ex-session-chat', fn, value);
  const fixture = (fn, value) => capture.component('ex-connected-workspace-demo', fn, value);
  const quiet = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const position = () => capture.evaluate(() => {
    const viewport = document.querySelector('ex-chat-scroll .viewport');
    const answer = [...viewport.querySelectorAll('[data-chat-row]')].at(-1);
    viewport.scrollTop += answer.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 100;
    viewport.dispatchEvent(new window.Event('scroll'));
    return { top: answer.getBoundingClientRect().top, id: answer.getAttribute('data-chat-row'), scrollTop: viewport.scrollTop };
  });
  const frames = () => capture.evaluate(async () => {
    const viewport = document.querySelector('ex-chat-scroll .viewport');
    const row = [...viewport.querySelectorAll('[data-chat-row]')].at(-1);
    const samples = [];
    for (let i = 0; i < 40; i++) {
      await new Promise(requestAnimationFrame);
      samples.push({ top: row.getBoundingClientRect().top, connected: row.isConnected,
        scrollTop: viewport.scrollTop, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
    }
    return samples;
  });
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      const captureQuery = `?chatLoading=window&capture=${prefix}`;
      await capture.evaluate(query => { location.href = '/connected-workspace' + query; }, captureQuery);
      await capture.waitFor(query => location.search === query &&
        document.querySelector('ex-machine-workspace ex-task-list'), captureQuery);
      await capture.theme(theme); await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await fixture(async owner => {
        owner.fixture.chat.scenario('new', 101);
        const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
        const row = { id: '', kind: 'assistant', text: '', timestamp: '2026-11-17T10:00:00Z', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
        owner.fixture.chat.seed(101, { state: result.value.state, items: [
          { ...row, id: 'distant-prompt', kind: 'user', text: 'Keep the original request available throughout this very long turn.' },
          ...Array.from({ length: 1000 }, (_, i) => ({ ...row, id: `evidence-${i}`, kind: i % 4 ? 'system' : 'assistant', text: `Checked source ${i}. The request must remain anchored while more history arrives.` })),
          { ...row, id: 'long-answer', text: Array.from({ length: 25 }, (_, i) => `Paragraph ${i + 1}: the final answer stays exactly where you are reading while earlier records load. This is deliberately tall enough to scroll independently of the history boundary.`).join('\n\n') },
        ] });
      });
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() => document.querySelector('[data-user-message="distant-prompt"]'));
      await quiet();
      const opening = await chat(owner => ({ size: owner.store.items().length, first: owner.store.items()[0]?.id }));
      assert.deepEqual(opening, { size: 320, first: 'evidence-681' }, 'Opening at the end must not drain collapsed history');
      await capture.fill('ex-composer textarea', 'Retain this draft through every page');
      const initial = await position(); await quiet();
      assert.ok(await capture.evaluate(() => document.querySelector('.reminder .quote')?.textContent.includes('original request')));
      await fixture(owner => owner.fixture.chat.holdReads(true));
      await chat(owner => { void owner.store.older(); });
      assert.equal(await chat(owner => owner.store.historyLoading()), true);
      assert.ok(await capture.evaluate(() => document.querySelector('.reminder .quote')?.textContent.includes('original request')), 'Loading hid the prompt context');
      assert.equal(await capture.evaluate(() => document.querySelector('ex-chat-loading, .history-indicator')), null);
      yield { name: `${prefix}-pending-context`, inspect: ['ex-chat-scroll .viewport', '.reminder'] };
      // Sample release and the following natural frames together.
      const samples = await fixture(async owner => {
        const row = [...document.querySelectorAll('[data-chat-row]')].at(-1);
        const samples = [];
        owner.fixture.chat.holdReads(false);
        for (let i = 0; i < 40; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({ top: row.getBoundingClientRect().top, connected: row.isConnected });
        }
        return samples;
      });
      for (const sample of samples) {
        assert.equal(sample.connected, true, 'Paging replaced the mounted reply');
        assert.ok(Math.abs(sample.top - initial.top) < 2, `Reply jumped ${sample.top - initial.top}px`);
      }
      for (let i = 0; i < 7; i++) {
        await chat(owner => owner.store.older()); await quiet();
        assert.ok(await chat(owner => owner.store.items().length <= 320));
        assert.equal(await chat(owner => owner.store.exchanges()[0].id), 'distant-prompt');
      }
      assert.equal(await chat(owner => owner.store.historical()), true);
      while (await chat(owner => !!owner.store.next())) {
        await chat(owner => owner.store.newer()); await quiet();
        assert.ok(await chat(owner => owner.store.items().length <= 320));
      }
      await position(); await quiet();
      const stable = await frames();
      assert.ok(stable.every(sample => Math.abs(sample.top - stable[0].top) < 2 && sample.connected));
      assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Retain this draft through every page');
      yield { name: `${prefix}-long-turn-restored`, inspect: ['ex-chat-scroll .viewport', '.reminder', 'ex-composer'], metadata: { samples } };
      // Prepending inside an expanded turn moves its contents while its outer
      // edge stays fixed. The visible answer must keep its own row anchor.
      await chat(owner => owner.store.refresh()); await quiet();
      await capture.component('ex-turn', owner => owner.toggleWork()); await quiet();
      await position(); await quiet();
      await fixture(owner => owner.fixture.chat.holdReads(true));
      await chat(owner => { void owner.store.older(); });
      // The reader changes position while transport is pending; preserve the
      // newer position rather than the one captured when the request began.
      await capture.evaluate(() => {
        const viewport = document.querySelector('ex-chat-scroll .viewport');
        viewport.scrollTop += 80;
        viewport.dispatchEvent(new window.Event('scroll'));
      });
      const expandedTop = await capture.evaluate(() => [...document.querySelectorAll('[data-chat-row]')].at(-1).getBoundingClientRect().top);
      const expanded = await fixture(async owner => {
        const row = [...document.querySelectorAll('[data-chat-row]')].at(-1);
        const samples = [];
        owner.fixture.chat.holdReads(false);
        for (let i = 0; i < 40; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({ top: row.getBoundingClientRect().top, connected: row.isConnected });
        }
        return samples;
      });
      assert.ok(expanded.every(sample => sample.connected && Math.abs(sample.top - expandedTop) < 2), 'Expanded work moved the answer or overrode the reader');
      yield { name: `${prefix}-expanded-reading`, inspect: ['ex-chat-scroll .viewport', '.reminder'], metadata: { expandedTop, samples: expanded } };
      for (const source of recorded) {
        await fixture((owner, source) => owner.fixture.chat.seed(101, source), source);
        await chat(owner => owner.latest()); await quiet();
        const state = await chat(owner => ({ first: owner.store.items()[0], prompt: owner.store.exchanges()[0]?.prompt, size: owner.store.items().length }));
        assert.ok(state.prompt, `Session ${source.id} opened without its preceding prompt`);
        assert.ok(state.size <= 320);
        const pinned = await frames();
        assert.ok(pinned.every(sample => sample.connected && Math.abs(sample.gap) <= 1));
        if (await chat(owner => !!owner.store.before())) { await chat(owner => owner.store.older()); await quiet(); }
        yield { name: `${prefix}-recorded-${source.id}`, inspect: ['ex-chat-scroll .viewport', 'ex-composer'], metadata: { sourceSession: source.id, sourceItems: source.items.length } };
      }
    }
  }
}
