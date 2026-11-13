import assert from 'node:assert/strict';

/** Four provider-shaped fixtures through the production chat owner and typed client. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  const ready = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const openPanel = async () => {
    await capture.waitFor(() => !!document.querySelector('ex-session-activity .trigger'));
    await capture.click('ex-session-activity .trigger');
    await capture.waitFor(() => !!document.querySelector('.cdk-overlay-container .panel'));
  };
  const expected = {
    claude: { running: 3, stops: 3, background: true, waiting: 1 },
    codex: { running: 2, stops: 2, background: false, waiting: 1 },
    opencode: { running: 2, stops: 2, background: false, waiting: 0 },
    pi: { running: 0, stops: 0, background: false, waiting: 0 },
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    for (const provider of ['claude', 'codex', 'opencode', 'pi']) {
      await capture.component('ex-connected-workspace-demo', (c, provider) => c.fixture.chat.activity(provider), provider);
      await openPanel();
      await ready();
      const facts = await capture.evaluate(() => ({
        running: document.querySelectorAll('.panel .work').length,
        stops: document.querySelectorAll('.panel .work button[aria-label^="Stop "]').length,
        background: !!document.querySelector('.panel .work button[aria-label="Run in background"]'),
        waiting: document.querySelectorAll('.panel .work[data-status="waiting"]').length,
        answers: document.querySelectorAll('.panel .work .answer').length,
        // Controls rest hidden until a row is hovered or focused.
        restingControls: [...document.querySelectorAll('.panel .work .actions')].some(e => getComputedStyle(e).opacity !== '0'),
      }));
      assert.deepEqual(
        { running: facts.running, stops: facts.stops, background: facts.background, waiting: facts.waiting },
        expected[provider],
      );
      assert.equal(facts.answers, expected[provider].waiting);
      assert.equal(facts.restingControls, false);
      yield { name: `${theme}-${provider}-activity`, selector: '.cdk-overlay-container .panel', inspect: ['.panel', '.panel .work', '.panel .event'] };
      if (provider === 'claude') {
        await capture.hover('.panel .work[data-status="running"].inspectable');
        await capture.waitFor(() => getComputedStyle(document.querySelector('.panel .work[data-status="running"].inspectable .actions')).opacity === '1');
        await ready();
        yield { name: `${theme}-claude-row-hover`, selector: '.cdk-overlay-container .panel', inspect: ['.panel .work[data-status="running"].inspectable'] };
      }
      if (provider !== 'pi') {
        await capture.click('.panel .rows:first-of-type > .work:first-child .inspect');
        await capture.waitFor(() => document.querySelectorAll('.agent-dialog .entries > li').length >= 3);
        await ready();
        yield { name: `${theme}-${provider}-agent`, inspect: ['.agent-dialog', '.agent-dialog .transcript'] };
        await capture.click('.agent-dialog .page-link');
        await capture.waitFor(() => document.querySelectorAll('.agent-dialog .entries > li').length === 1);
        await capture.click('.agent-dialog footer button');
        await capture.waitFor(() => document.querySelectorAll('.agent-dialog .entries > li').length >= 3);
        if (provider === 'codex') {
          await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.agentReply = 'error'; });
          await capture.click('.agent-dialog .head-actions ex-icon-button:first-child button');
          await capture.waitFor(() => !!document.querySelector('.agent-dialog [role="alert"]'));
          yield { name: `${theme}-agent-error`, inspect: ['.agent-dialog [role="alert"]'] };
          await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.agentReply = 'starting'; });
          await capture.click('.agent-dialog .head-actions ex-icon-button:first-child button');
          await capture.waitFor(() => document.querySelector('.agent-dialog .empty')?.textContent.includes('Waiting for the first message'));
          yield { name: `${theme}-agent-starting`, inspect: ['.agent-dialog .empty'] };
          await capture.component('ex-connected-workspace-demo', c => { c.fixture.chat.agentReply = 'ready'; });
        }
        await capture.press('Escape');
        await capture.waitFor(() => !document.querySelector('.agent-dialog'));
        assert.equal(await capture.evaluate(() => document.activeElement?.classList.contains('inspect')), true);
        if (provider === 'claude') {
          // Keyboard focus reveals hidden controls; Enter performs them.
          await capture.evaluate(() => document.querySelector('.panel .work button[aria-label="Run in background"]').focus());
          await capture.waitFor(() => getComputedStyle(document.activeElement.closest('.actions')).opacity === '1');
          await capture.press('Enter');
          await capture.waitFor(() => !document.querySelector('.panel .work button[aria-label="Run in background"]'));
        }
      }
      if (expected[provider].waiting) {
        // Answer closes the panel, then focus lands on the conversation's pending decision.
        await capture.click('.panel .work .answer');
        await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));
        await capture.waitFor(() => !!document.activeElement?.closest('ex-session-chat section.question'));
      } else {
        await capture.press('Escape');
        await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));
        assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-session-activity .trigger')), true);
      }
    }
    await capture.viewport(620, 720); await capture.reducedMotion(true);
    await capture.component('ex-connected-workspace-demo', c => c.fixture.chat.activity('codex'));
    await openPanel();
    await capture.waitFor(() => document.querySelectorAll('.panel .work').length === 2);
    await capture.component('ex-session-chat', c => c.store.busy.set('validation'));
    assert.equal(await capture.evaluate(() => [...document.querySelectorAll('.panel .work button[aria-label^="Stop "]')].every(button => button.disabled)), true);
    yield { name: `${theme}-activity-narrow-disabled`, inspect: ['.panel', '.panel .work'] };
    await capture.click('.panel .rows:first-of-type > .work:first-child .inspect');
    await capture.waitFor(() => !!document.querySelector('.agent-dialog .entries > li'));
    yield { name: `${theme}-agent-narrow`, inspect: ['.agent-dialog'] };
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.agent-dialog'));
    await capture.press('Escape'); await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));
    await capture.component('ex-session-chat', c => c.store.busy.set(''));
  }
}
