import assert from 'node:assert/strict';

/** Seamless history paging through the production chat with a 4,000-item fixture. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-session-chat ex-agent-picker > button'));
  const chat = (fn, value) => capture.component('ex-session-chat', fn, value);
  const move = async (edge) => {
    // Absolute scrollTop coordinates use the settled range. The dedicated
    // scrollbar scenario covers relative wheel input during reconciliation.
    await capture.waitFor(() => !document.querySelector('ex-session-chat .viewport.reconciling-history'));
    // Native scroll container plus trusted wheel input supplies direction/intent.
    await capture.evaluate(edge => {
      const viewport = document.querySelector('ex-session-chat ex-chat-scroll .viewport');
      viewport.scrollTop = edge === 'top' ? 300 : viewport.scrollHeight - viewport.clientHeight - 300;
    }, edge);
    await capture.settle();
    const box = await capture.evaluate(() => {
      const r = document.querySelector('ex-session-chat ex-chat-scroll .viewport').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', ...box, deltaX: 0, deltaY: edge === 'top' ? -120 : 120 });
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960);
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('history'));
    await chat(c => c.latest());
    await capture.waitFor(() => document.querySelector('ex-chat-scroll .content')?.textContent.includes('Check request 1999'));
    await capture.fill('ex-composer textarea', 'Keep this draft while I read');
    assert.equal(await capture.evaluate(() => !!document.querySelector('.history-controls')), false);
    await capture.evaluate(() => { document.querySelector('ex-session-chat ex-chat-scroll .viewport').scrollTop = 1500; });
    await capture.settle();
    const anchor = await capture.evaluate(() => {
      const viewport = document.querySelector('ex-session-chat ex-chat-scroll .viewport');
      const row = [...viewport.querySelectorAll('[data-chat-anchor]')].find(row => row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
      return { id: row.getAttribute('data-chat-anchor'), top: row.getBoundingClientRect().top };
    });
    await chat(c => c.store.older()); await capture.settle();
    const offset = await capture.evaluate(id => document.querySelector(`[data-chat-anchor="${id}"]`).getBoundingClientRect().top, anchor.id);
    assert.ok(Math.abs(offset - anchor.top) < 2, `Prepending moved the reading anchor by ${offset - anchor.top}px`);
    for (let i = 0; i < 7; i++) {
      const before = await chat(c => c.store.items()[0]?.id);
      await move('top');
      await capture.waitFor(before => document.querySelector('ex-chat-scroll [data-user-message]')?.getAttribute('data-user-message') !== before, before);
      await capture.settle();
      const state = await chat(c => ({ size: c.store.items().length, ids: c.store.items().map(i => Number(i.id.split('-')[1])), error: c.store.historyError() }));
      assert.ok(state.size <= 320); assert.equal(state.error, '');
      assert.ok(state.ids.every((id, i) => !i || id === state.ids[i - 1] + 1));
    }
    assert.equal(await chat(c => c.store.historical()), true);
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').disabled), false);
    yield { name: `${theme}-seamless-history`, inspect: ['ex-chat-scroll', 'ex-composer'] };
    for (let i = 0; i < 7; i++) {
      if (!await chat(c => !!c.store.next())) break;
      const tail = await chat(c => c.store.items().at(-1)?.id);
      await move('bottom');
      await capture.waitFor(tail => [...document.querySelectorAll('ex-chat-scroll [data-user-message]')].at(-1)?.getAttribute('data-user-message') !== tail, tail.replace(/\d+$/, n => String(Number(n) - 1)));
      await capture.settle();
    }
    await chat(c => c.latest());
    await capture.waitFor(() => document.querySelector('ex-chat-scroll .content')?.textContent.includes('Check request 1999'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-composer textarea').value), 'Keep this draft while I read');
    await capture.viewport(900, 700); await capture.reducedMotion(true);
    await move('top'); await capture.settle();
    yield { name: `${theme}-narrow-history-reduced`, inspect: ['ex-chat-scroll', 'ex-composer'] };
    await capture.evaluate(() => document.querySelector('ex-chat-scroll .viewport').focus());
    await capture.press('PageUp');
    await capture.settle();
    assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('viewport')), true);
    await capture.reducedMotion(false);
  }
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1100, 800);
    await capture.evaluate(() => document.querySelector('ex-composer textarea').focus());
    await chat(c => c.agentId.set('scroll-inspector'));
    await capture.waitFor(() => document.querySelector('.agent-dialog .entries')?.textContent.includes('The transaction boundary is safe.'));
    await capture.waitFor(() => document.querySelector('.agent-dialog .entries')?.textContent.includes('Inspect the payment retry handler.'));
    assert.equal(await capture.evaluate(() => !!document.querySelector('.agent-dialog .page-link, .agent-dialog footer button')), false);
    await capture.settle();
    yield { name: `${theme}-agent-scroll`, inspect: ['.agent-dialog', '.agent-dialog .transcript'] };
    await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.agentReply = 'error'; });
    await capture.click('.agent-dialog .head-actions ex-icon-button:first-child button');
    await capture.waitFor(() => document.querySelector('.agent-dialog [role=alert]'));
    assert.ok(await capture.evaluate(() => document.querySelector('.agent-dialog .entries')?.textContent.includes('The transaction boundary is safe.')));
    yield { name: `${theme}-agent-history-error`, inspect: ['.agent-dialog'] };
    await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.agentReply = 'ready'; });
    await capture.viewport(800, 700); await capture.reducedMotion(true);
    await capture.click('.agent-dialog .banner.danger button');
    await capture.waitFor(() => !document.querySelector('.agent-dialog [role=alert]'));
    yield { name: `${theme}-agent-scroll-narrow-reduced`, inspect: ['.agent-dialog'] };
    await capture.evaluate(() => document.querySelector('.agent-dialog ex-icon-button[icon=x] button').focus());
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('.agent-dialog'));
    await capture.reducedMotion(false);
  }

}
