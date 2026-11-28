import assert from 'node:assert/strict';

/** Shell receipts through the production session owner; only backend data is supplied. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  const scroll = selector => capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), selector);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const tool = index => `[data-work-step="shell-${index}"] ex-tool-step`;
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(1440, 960);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('shell-results'));
    await capture.waitFor(() => document.querySelector('ex-turn[data-chat-anchor="shell-prompt:reply"] .answer')?.textContent.includes('desktop checks passed'));
    await finish();
    const turn = 'ex-turn[data-chat-anchor="shell-prompt:reply"]';
    await scroll(turn + ' .work');
    if (await capture.evaluate(selector => document.querySelector(selector + ' .work').getAttribute('aria-expanded') !== 'true', turn)) await capture.click(turn + ' .work');
    await finish();
    for (let count = 0; count < 4; count++) {
      const closed = turn + ' ex-work-timeline .group[aria-expanded="false"]';
      if (!await capture.evaluate(selector => !!document.querySelector(selector), closed)) break;
      await scroll(closed); await capture.click(closed); await finish();
    }
    for (let index = 0; index < 4; index++) {
      const selector = tool(index);
      await scroll(selector + ' .head');
      if (await capture.evaluate(selector => document.querySelector(selector + ' .head').getAttribute('aria-expanded') !== 'true', selector)) {
        await capture.evaluate(selector => document.querySelector(selector + ' .head').focus(), selector);
        await capture.press('Enter');
      }
      await finish();
      assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' ex-shell-tool'), selector), true);
      if (index === 0) {
        assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .screen').textContent, selector), /12 tests passed/);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .screen span').style.fontWeight, selector), '');
        await scroll(selector + ' [aria-label="Copy captured output"]');
        await capture.click(selector + ' [aria-label="Copy captured output"]');
        await capture.waitFor(selector => !!document.querySelector(selector + ' [aria-label="Output copied"]'), selector);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .screen').textContent.includes('\u001b'), selector), false);
      }
      if (index === 1) assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' section.failed'), selector), true);
      if (index === 2) {
        assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .empty').textContent, selector), /completed without output/);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' [aria-label="Copy captured output"]').disabled, selector), true);
      }
      if (index === 3) {
        await capture.component(selector + ' ex-shell-tool', component => { component.jumpToEnd(); if (component.expanded()) component.showMore(); });
        await finish();
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' .terminal-line').length, selector), 80);
        await capture.component(selector + ' ex-shell-tool', component => component.showMore());
        await finish();
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' .terminal-line').length, selector), 240);
        await scroll(selector + ' .screen');
        await capture.evaluate(selector => {
          const screen = document.querySelector(selector + ' .screen'); screen.scrollTop = 0;
          screen.dispatchEvent(new window.Event('scroll'));
        }, selector);
        await finish();
        assert.equal(await capture.evaluate(selector => [...document.querySelectorAll(selector + ' button')].some(button => button.textContent.includes('Jump to latest')), selector), true);
        const reading = await capture.evaluate(selector => document.querySelector(selector + ' .screen').textContent, selector);
        await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.appendShellOutput('\nA new result arrived'));
        await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('New output available'), selector);
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .screen').textContent, selector), reading);
        await capture.component(selector + ' ex-shell-tool', component => component.jumpToEnd());
        await finish();
        assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .screen').textContent, selector), /A new result arrived/);
      }
      await scroll(selector);
      if (await capture.evaluate(() => !!document.querySelector('ex-chat-scroll .reminder-top button'))) await capture.click('ex-chat-scroll .reminder-top button');
      await finish();
      yield { name: `${theme}-${['passed','failed','empty','long-output'][index]}`, selector, inspect: [selector, selector + ' .screen'] };
    }
    await capture.viewport(1000, 760);
    await capture.reducedMotion(true);
    await scroll(tool(0)); await finish();
    assert.equal(await capture.evaluate(selector => {
      const card = document.querySelector(selector + ' .tool-content'); return card.scrollWidth <= card.clientWidth + 1;
    }, tool(0)), true);
    yield { name: `${theme}-narrow-reduced-motion`, selector: tool(0), inspect: [tool(0)] };
    await capture.reducedMotion(false);
    // Reset disclosure before reusing the same keyed fixture in the next theme.
    await scroll('ex-turn[data-chat-anchor="shell-prompt:reply"] .work'); await capture.click('ex-turn[data-chat-anchor="shell-prompt:reply"] .work'); await finish();
  }
}
