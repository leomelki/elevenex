import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  const scenario = mode => capture.component('ex-connected-workspace-demo', (c, mode) => c.fixture.chat.scenario(mode), mode);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const scroll = async selector => {
    await capture.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), selector);
    if (await capture.evaluate(() => !!document.querySelector('.reminder .hide')))
      await capture.click('.reminder .hide');
    await finish();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1440, 960);
    await scenario('running');
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('Two requests'));
    await finish();
    const order = await capture.evaluate(() => {
      const answer = document.querySelector('ex-turn .answer');
      const tools = [...document.querySelectorAll('ex-turn ex-tool-step')];
      return {
        preceding: !!(tools[1].compareDocumentPosition(answer) & window.Node.DOCUMENT_POSITION_FOLLOWING),
        following: !!(answer.compareDocumentPosition(tools[2]) & window.Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    assert.deepEqual(order, { preceding: true, following: true });
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-turn .answer .caret').length), 0);
    yield { name: theme + '-message-before-running-tool', inspect: ['ex-turn .answer', 'ex-turn ex-work-timeline', 'ex-turn .summary-facts'] };
    await scroll('[data-work-step="test"] ex-tool-step .head');
    if (await capture.evaluate(() => document.querySelector('[data-work-step="test"] ex-tool-step .head').getAttribute('aria-expanded') !== 'true'))
      await capture.click('[data-work-step="test"] ex-tool-step .head');
    await finish();
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-turn ex-tool-step .head')].at(-1)?.getAttribute('aria-expanded')), 'true');
    yield { name: theme + '-tool-input-expanded', inspect: ['ex-turn ex-tool-step pre'] };
    await scroll('ex-turn .work');
    await capture.click('ex-turn .work');
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-turn .work').getAttribute('aria-expanded')), 'false');
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-turn ex-tool-step')].filter(t => !t.querySelector('section.running')).every(t => !!t.closest('ex-fold[inert]'))), true);
    await scroll('ex-turn .work');
    await capture.click('ex-turn .work');
    await finish();
    yield { name: theme + '-work-reopened', inspect: ['ex-turn .answer', 'ex-turn ex-work-timeline'] };

    await scenario('ready');
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('All'));
    await scroll('ex-turn .work');
    await capture.click('ex-turn .work');
    await finish();
    await capture.click('ex-composer textarea');
    await finish();
    const summary = '[data-work-step="test"] .group';
    assert.match(await capture.evaluate(s => document.querySelector(s).getAttribute('aria-label'), summary), /1 command/);
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('ex-turn .work .fact')]
      .some(fact => fact.textContent.includes('command') && Number(getComputedStyle(fact).opacity) > 0)), false);
    yield { name: theme + '-section-summary', inspect: ['ex-turn .work', summary] };
    await capture.evaluate(() => document.querySelector('ex-turn .work').focus());
    await finish();
    await capture.press('Enter');
    await finish();
    yield { name: theme + '-keyboard-expanded-history', inspect: ['ex-turn .work', 'ex-turn ex-work-timeline'] };
    await capture.viewport(1000, 760);
    await capture.reducedMotion(true);
    await scenario('running');
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('Two requests'));
    await finish();
    yield { name: theme + '-narrow-reduced-motion', inspect: ['ex-turn .answer', 'ex-turn .work'] };
    await capture.reducedMotion(false);
  }
}
