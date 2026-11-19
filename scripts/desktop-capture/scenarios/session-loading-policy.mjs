import assert from 'node:assert/strict';

/** Adaptive opening, bounded history and mounted identities through real updates. */
export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
      await capture.theme(theme);
      await capture.viewport(narrow ? 1000 : 1440, narrow ? 760 : 960);
      await capture.reducedMotion(narrow);
      await capture.component('ex-connected-workspace-demo', async owner => {
        owner.fixture.chat.scenario('new', 101);
        const result = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
        const base = { timestamp: '2026-11-18T10:00:00Z', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
        const items = Array.from({ length: 1000 }, (_, turn) => [
          { ...base, id: `prompt-${turn}`, kind: 'user', text: `Inspect request ${turn}` },
          ...Array.from({ length: 4 }, (_, i) => [
            { ...base, id: `tool-${turn}-${i}`, kind: 'tool_use', text: '', toolId: `tool-${turn}-${i}`, toolKind: 'bash', input: '{"cmd":"pnpm test"}' },
            { ...base, id: `result-${turn}-${i}`, kind: 'tool_result', toolId: `tool-${turn}-${i}`, text: 'Tests passed' },
          ]).flat(),
          { ...base, id: `answer-${turn}`, kind: 'assistant', text: `Request ${turn} is complete. The answer and its work stay mounted through later updates.` },
        ]).flat();
        owner.fixture.chat.seed(101, { state: { ...result.value.state, phase: 'running', canInterrupt: true }, items });
      });
      const opening = await capture.component('ex-machine-workspace', async owner => {
        const start = performance.now();
        owner.store.selectSession({ taskId: '11', sessionId: '101' });
        window.ng.applyChanges(owner);
        while (!document.querySelector('[data-chat-row="answer-999"]')) await new Promise(requestAnimationFrame);
        return { milliseconds: performance.now() - start,
          records: window.ng.getComponent(document.querySelector('ex-session-chat')).store.items().length };
      });
      assert.equal(opening.records, 320);
      assert.equal(await capture.component('ex-session-chat', owner => owner.store.progressiveLoading()), false);
      await capture.fill('ex-composer textarea', 'Keep my draft and focus');
      const updates = await capture.component('ex-session-chat', async owner => {
        const fixture = window.ng.getComponent(document.querySelector('ex-connected-workspace-demo')).fixture.chat;
        const node = [...document.querySelectorAll('ex-chat ex-turn')].at(-2);
        const turn = window.ng.getComponent(node);
        const composer = document.querySelector('ex-composer');
        const old = owner.store.exchanges().at(-2);
        const measurements = [];
        for (let i = 0; i < 12; i++) {
          const id = `incoming-${i}`, start = performance.now();
          const page = await fixture.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID(), loadingMode: 'window' });
          // Repeated IPC-style records deliberately arrive with new identities.
          fixture.seed(101, { state: page.value.state, items: [
            ...page.value.items.map(item => ({ ...item })),
            { id, kind: 'tool_use', text: '', timestamp: '2026-11-18T10:00:00Z', toolId: id, toolName: null, toolKind: 'bash', input: '{"cmd":"pnpm test"}', error: false, truncated: false },
          ] });
          while (!owner.store.items().some(item => item.id === id)) await new Promise(requestAnimationFrame);
          measurements.push(performance.now() - start);
          if (owner.store.exchanges().find(exchange => exchange.id === old.id) !== old || !node.isConnected || window.ng.getComponent(node) !== turn ||
              composer !== document.querySelector('ex-composer')) throw new Error('Unchanged conversation UI was replaced');
          if (owner.store.items().length > 320) throw new Error('History window grew beyond its bound');
        }
        return measurements;
      });
      assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep my draft and focus');
      const prefix = `${theme}-${narrow ? 'narrow-reduced' : 'wide'}`;
      yield { name: `${prefix}-fast-window`, inspect: ['ex-chat-scroll', 'ex-composer'], metadata: { opening, updates } };

      await capture.component('ex-connected-workspace-demo', owner => {
        owner.fixture.chat.scenario('history', 102);
        owner.fixture.chat.holdReads(true);
      });
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '102' }));
      await capture.waitFor(() => document.querySelector('.opening ex-chat-loading small')?.textContent === 'Progressive');
      yield { name: `${prefix}-slow-opening`, inspect: ['.opening', 'ex-chat-loading'] };
      await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.holdReads(false));
      await capture.waitFor(() => document.querySelector('ex-composer'));
      assert.equal(await capture.component('ex-session-chat', owner => owner.store.progressiveLoading()), true);
      assert.ok(await capture.component('ex-session-chat', owner => owner.store.items().length <= 160));
      // Small history requests expose the same unobtrusive mode indicator.
      await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.holdReads(true));
      await capture.component('ex-session-chat', owner => { void owner.store.older(); });
      await capture.waitFor(() => {
        const indicator = document.querySelector('.history-indicator');
        return indicator?.querySelector('small') && Number(getComputedStyle(indicator).opacity) > 0.9;
      });
      yield { name: `${prefix}-progressive-history`, inspect: ['.history-indicator', 'ex-chat-scroll'] };
      await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.holdReads(false));
      await capture.waitFor(() => !window.ng.getComponent(document.querySelector('ex-session-chat')).store.historyLoading());

      // Another task/chat inherits the connection-wide choice immediately,
      // without waiting through another three-second slow-open deadline.
      await capture.component('ex-connected-workspace-demo', owner => {
        owner.fixture.chat.scenario('history', 103);
        owner.fixture.chat.holdReads(true);
      });
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '12', sessionId: '103' }));
      await capture.waitFor(() => {
        const chat = document.querySelector('ex-session-chat');
        return chat && window.ng.getComponent(chat).selection()?.sessionId === 103;
      });
      assert.equal(await capture.component('ex-session-chat', owner => owner.store.progressiveLoading()), true);
      await capture.waitFor(() => document.querySelector('.opening ex-chat-loading small'));
      yield { name: `${prefix}-shared-fallback`, inspect: ['.opening', 'ex-chat-loading'] };
      await capture.component('ex-connected-workspace-demo', owner => owner.fixture.chat.holdReads(false));
      await capture.waitFor(() => document.querySelector('ex-composer'));
      await capture.component('ex-connected-workspace-demo', owner => owner.workspaceVisible.set(false));
      await capture.waitFor(() => !document.querySelector('ex-machine-workspace'));
      await capture.component('ex-connected-workspace-demo', owner => owner.workspaceVisible.set(true));
      await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '12', sessionId: '103' }));
      await capture.waitFor(() => {
        const chat = document.querySelector('ex-session-chat');
        return chat && window.ng.getComponent(chat).selection()?.sessionId === 103;
      });
      assert.equal(await capture.component('ex-session-chat', owner => owner.store.progressiveLoading()), true);

      await capture.component('ex-connected-workspace-demo', owner => owner.fixture.ready());
      await capture.waitFor(() => {
        const owner = window.ng.getComponent(document.querySelector('ex-session-chat'));
        return owner && !owner.store.offline() && !owner.store.progressiveLoading();
      });
      await capture.waitFor(() => document.querySelector('ex-composer'));
      yield { name: `${prefix}-reconnected-normal`, inspect: ['ex-chat-scroll', 'ex-composer'] };
    }
  }
}
