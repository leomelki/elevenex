import assert from 'node:assert/strict';
/** Real connected chat: bulk retention, deferred replies, stable navigation and theme/width recovery. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('history'));
  await capture.component('ex-session-chat', component => component.latest());
  await capture.waitFor(() => document.querySelectorAll('ex-chat .reply-window').length === 2000);
  await capture.waitFor(() => document.querySelector('[data-chat-anchor="history-3998:reply"] ex-turn'));
  const initial = await capture.component('ex-session-chat', component => ({ items: component.store.items().length, before: component.store.before(), after: component.store.next() }));
  const mounted = await capture.evaluate(() => document.querySelectorAll('ex-chat ex-turn').length);
  assert.equal(initial.items, 4000); assert.equal(initial.before, null); assert.equal(initial.after, null);
  assert(mounted < 80, `expected deferred replies, got ${mounted}`);
  yield {name: 'bulk-loaded-tail', metadata: {initial, mounted}, inspect: ['ex-chat-scroll .viewport', 'ex-composer']};
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.evaluate(() => { const el = document.querySelector('ex-chat-scroll .viewport'); el.scrollTop = 0; });
    await capture.waitFor(() => document.querySelector('ex-chat .reply-window ex-turn .answer')?.textContent.includes('Verified request 0.'));
    await capture.settle();
    const first = await capture.evaluate(() => document.querySelector('ex-chat .reply-window').getBoundingClientRect().height);
    yield {name: theme + '-start', metadata: {first}, inspect: ['ex-chat-scroll .viewport', 'ex-composer']};
    await capture.component('ex-session-chat', component => component.chat().scroll().scrollToMessage('history-2000'));
    await capture.waitFor(() => document.querySelector('[data-chat-anchor="history-2000:reply"] ex-turn'));
    await capture.settle();
    await capture.waitFor(() => Math.abs(document.querySelector('[data-user-message="history-2000"]').getBoundingClientRect().top - document.querySelector('ex-chat-scroll .viewport').getBoundingClientRect().top - 24) < 2);
    yield {name: theme + '-middle', inspect: ['ex-chat-scroll .viewport']};
    await capture.component('ex-session-chat', component => component.chat().scroll().scrollToEnd('instant'));
    await capture.settle();
    assert.equal(await capture.component('ex-session-chat', component => component.store.items().length), 4000);
    yield {name: theme + '-return', inspect: ['ex-chat-scroll .viewport']};
  }
  await capture.viewport(720, 780); await capture.reducedMotion(true);
  await capture.component('ex-session-chat', component => component.chat().scroll().scrollToMessage('history-2000'));
  await capture.settle();
  await capture.evaluate(() => document.querySelector('ex-chat-scroll .viewport').focus());
  await capture.press('Home');
  assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-chat-scroll .viewport')), true);
  yield {name: 'narrow-reduced', inspect: ['ex-chat-scroll .viewport', 'ex-composer']};
}
