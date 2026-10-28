import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const select = id => capture.component('ex-machine-workspace', (c, id) => c.store.selectSession({ taskId: '11', sessionId: id }), id);
  const finish = async () => { await capture.settle(); await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')); };
  await select('101');
  await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.deferUserReceipts(true));
  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960); await capture.theme(theme);
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.scenario('reply-boundaries'));
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length === 2 && document.querySelectorAll('ex-turn .answer')[1]?.textContent.includes('Created the test file'));
    await finish();
    assert.deepEqual(await capture.evaluate(() => [...document.querySelectorAll('ex-turn .work')].map(b => b.getAttribute('aria-expanded'))), ['false', 'false']);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-turn .answer .caret').length), 0);
    yield { name: theme + '-visible-final-replies', inspect: ['ex-turn .answer', 'ex-turn .work'] };
    await capture.fill('ex-composer textarea', 'Check another file'); await capture.press('Enter');
    await capture.waitFor(() => document.querySelectorAll('ex-turn').length === 3 && document.querySelectorAll('ex-turn .answer')[2]?.textContent.includes('I’ll check'));
    const turns = await capture.component('ex-session-chat', c => c.store.exchanges().map(e => ({ prompt: e.prompt, answer: e.answer, streaming: e.streaming })));
    assert.equal(turns[0].answer, 'Hi. How can I help?');
    assert.equal(turns[1].answer, 'Created the test file and verified its contents.');
    assert.equal(turns[2].prompt, 'Check another file');
    assert.equal(turns.filter(t => t.streaming).length, 1);
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-turn .answer .caret').length), 1);
    yield { name: theme + '-only-current-reply-streams', inspect: ['ex-turn .answer', 'ex-composer'] };
    await capture.waitFor(() => !document.querySelector('ex-session-chat .status')?.textContent.includes('Running'));
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-turn .answer .caret').length), 0);
    assert.equal((await capture.component('ex-session-chat', c => c.store.exchanges().length)), 3);
  }
  await select('102');
  await capture.waitFor(() => document.querySelector('ex-session-chat .start'));
  await capture.fill('ex-composer textarea', 'First message'); await capture.press('Enter');
  await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('I’ll check'));
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-session-chat .start')), false);
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-session-chat ex-skeleton')), false);
  yield { name: 'first-response-hides-welcome', inspect: ['ex-turn', 'ex-composer'] };
  await capture.waitFor(() => !document.querySelector('ex-session-chat .status')?.textContent.includes('Running'));
  await capture.viewport(1000, 760); await capture.reducedMotion(true); await finish();
  yield { name: 'narrow-settled-reply', inspect: ['ex-turn .answer', 'ex-session-chat'] };
}
