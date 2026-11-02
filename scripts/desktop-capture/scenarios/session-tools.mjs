import assert from 'node:assert/strict';

/** Real tool cards fed by bounded, provider-shaped preview receipts. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  const mode = value => capture.component('ex-connected-workspace-demo', (component, value) => component.fixture.chat.scenario(value), value);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const tool = index => `ex-work-timeline > ol > li:nth-child(${index + 1}) ex-tool-step`;
  const scroll = selector => capture.evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center' }), selector);
  const hideReminder = async () => {
    if (await capture.evaluate(() => !!document.querySelector('ex-chat-scroll .reminder-top button')))
      await capture.click('ex-chat-scroll .reminder-top button');
  };
  const examples = [
    ['command', '12 tests passed.', true],
    ['read', 'return provider.charge(request);', true],
    ['edit', 'const claim = await retries.claim(key);', true],
    ['search', 'src/payments/retry.spec.ts', true],
    ['write', 'export interface Claim', false],
    ['files', 'src/jobs/retry.ts', false],
    ['notebook', 'retries.groupby', true],
    ['web-search', 'Idempotent requests', true],
    ['web-fetch', '24 hours', false],
    ['patch', 'src/payments/claim.ts', true],
    ['agent', 'Cancellation does not release', true],
    ['todos', 'Document the retention period', true],
    ['collaboration', 'No duplicate provider calls found.', false],
    ['question', 'How long should a retry claim remain valid?', false],
    ['plan-mode', 'Entered plan mode.', false],
    ['plan-review', 'Claim the key atomically.', false],
    ['workspace', 'fix/retry-safety', false],
    ['language-server', 'src/payments/retry.spec.ts', false],
    ['skill', 'payment safety review instructions', false],
    ['mcp', 'Prevent duplicate charges', true],
    ['unknown', 'Payments API', true],
    ['failed-command', 'Dependency cache is missing.', true],
    ['shortened-output', 'Request 1:', true],
  ];

  for (const theme of ['light', 'dark']) {
    await capture.viewport(1440, 960);
    await capture.theme(theme);
    await mode('tools');
    await hideReminder();
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('offline run'));
    await finish();
    if (await capture.evaluate(() => document.querySelector('ex-turn .work').getAttribute('aria-expanded') !== 'true'))
      await capture.click('ex-turn .work');
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-work-timeline ex-tool-step').length), examples.length);

    for (let index = 0; index < examples.length; index++) {
      const [name, expected, screenshot] = examples[index];
      const selector = tool(index);
      await scroll(selector + ' .head');
      if (await capture.evaluate(selector => document.querySelector(selector + ' .head').getAttribute('aria-expanded') === 'true', selector)) {
        await capture.click(selector + ' .head');
        await finish();
      }
      if (index === 0) {
        await capture.evaluate(selector => document.querySelector(selector + ' .head').focus(), selector);
        await capture.press('Enter');
      } else {
        await capture.click(selector + ' .head');
      }
      await finish();
      assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .head').getAttribute('aria-expanded'), selector), 'true');
      const primary = await capture.evaluate(selector => [...document.querySelectorAll(selector + ' .tool-preview .tool-block')].map(block => block.textContent).join('\n'), selector);
      assert.ok(primary.trim(), `${name}: missing primary preview`);
      assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details')?.open, selector), false);
      const size = await capture.evaluate(selector => Math.ceil(document.querySelector(selector + ' .tool-content').getBoundingClientRect().height), selector);
      assert.ok(size <= 220, `${name}: default content is ${size}px high`);
      if (name === 'command') {
        assert.match(primary, /12 tests passed\./);
        assert.doesNotMatch(primary, /Working directory|Purpose|pnpm test retry|\/workspace\/payments/);
      }
      if (name === 'edit') {
        assert.match(primary, /const claim = await retries\.claim\(key\);/);
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' .tool-preview .diff-line').length >= 2, selector), true);
      }
      if (name === 'todos') {
        assert.match(primary, /Verify failure recovery/);
        assert.match(primary, /Document the retention period/);
        assert.doesNotMatch(primary, /Reproduce the race|Implement atomic claims/);
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' .tool-preview .tool-rows ex-status-glyph').length, selector), 2);
      }
      if (name === 'mcp') {
        assert.match(primary, /Prevent duplicate charges/);
        assert.match(primary, /In progress/);
        assert.doesNotMatch(primary, /PAY-218|Issue id|Connection|Parameters/);
      }
      if (name === 'failed-command') {
        assert.match(primary, /Dependency cache is missing/);
        assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' section.failed'), selector), true);
      }
      if (screenshot) {
        await scroll(selector);
        await hideReminder();
        await finish();
        yield { name: `${theme}-${name}`, selector, inspect: [selector, selector + ' .tool-preview'], metadata: { defaultHeight: size } };
      }

      await scroll(selector + ' .more-details > summary');
      if (index === 0) {
        await capture.evaluate(selector => document.querySelector(selector + ' .more-details > summary').focus(), selector);
        await capture.press('Enter');
      } else {
        await capture.click(selector + ' .more-details > summary');
      }
      await finish();
      assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details').open, selector), true);
      const parsed = await capture.evaluate(selector => [...document.querySelectorAll(selector + ' .more-details .tool-block')].map(block => block.textContent).join('\n'), selector);
      assert.ok(parsed.includes(expected), `${name}: missing full parsed content ${expected}`);
      assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .raw-details')?.open, selector), false);
      if (name === 'todos')
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' .more-details .tool-rows ex-status-glyph').length, selector), 4);
      if (name === 'unknown') {
        assert.equal(await capture.evaluate(() => window.__toolExecuted === true), false);
        assert.equal(await capture.evaluate(selector => document.querySelectorAll(selector + ' script').length, selector), 0);
      }
      if (name === 'shortened-output')
        assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .more-details .notice').textContent, selector), /short|limit|original|full/i);
      if (index === 0) {
        await scroll(selector);
        await hideReminder();
        await finish();
        yield { name: `${theme}-full-command-details`, selector, inspect: [selector, selector + ' .more-details'] };
        await scroll(selector + ' .raw-details summary');
        await capture.click(selector + ' .raw-details summary');
        await finish();
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .raw-details').open, selector), true);
        assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .raw-details pre').textContent, selector), /"exit_code":0/);
        await capture.press('Enter');
        assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .raw-details').open, selector), false);
      }
      await scroll(selector + ' .more-details > summary');
      await capture.click(selector + ' .more-details > summary');
      await finish();
      assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details').open, selector), false);
      await scroll(selector + ' .head');
      await capture.click(selector + ' .head');
      await finish();
      assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' ex-tool-content')?.closest('ex-fold[inert]'), selector), true);
    }

    await capture.viewport(1000, 760);
    await capture.reducedMotion(true);
    const edit = tool(2);
    await scroll(edit + ' .head');
    await capture.click(edit + ' .head');
    await finish();
    await scroll(edit);
    assert.equal(await capture.evaluate(selector => {
      const card = document.querySelector(selector + ' .tool-content');
      return card.scrollWidth <= card.clientWidth + 1;
    }, edit), true);
    yield { name: `${theme}-narrow-diff-reduced-motion`, inspect: [edit, 'ex-composer'] };

    await capture.evaluate(() => document.querySelector('ex-composer textarea').focus());
    await mode('tools-running');
    await capture.waitFor(() => document.querySelector('ex-turn .answer')?.textContent.includes('still running'));
    await finish();
    await hideReminder();
    const live = 'ex-now-line ex-tool-step';
    if (await capture.evaluate(() => document.querySelector('ex-work-timeline .earlier')))
      await capture.click('ex-work-timeline .earlier');
    await finish();
    await capture.waitFor(() => document.querySelector('ex-now-line ex-tool-step'));
    await scroll(live + ' .head');
    await capture.click(live + ' .head');
    await finish();
    assert.equal(await capture.evaluate(selector => !!document.querySelector(selector + ' section.running'), live), true);
    assert.match(await capture.evaluate(selector => document.querySelector(selector + ' .head').textContent, live), /pnpm test retry --watch/);
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .more-details').open, live), false);
    await scroll(live);
    await finish();
    yield { name: `${theme}-running-input`, selector: live, inspect: [live] };
    await scroll(live + ' .more-details > summary');
    await capture.click(live + ' .more-details > summary');
    await finish();
    assert.match(await capture.evaluate(selector => [...document.querySelectorAll(selector + ' .more-details .tool-block')].map(block => block.textContent).join('\n'), live), /pnpm test retry --watch/);
    await scroll(live + ' .more-details > summary');
    await capture.click(live + ' .more-details > summary');
    await finish();
    await mode('tools-incomplete');
    await capture.waitFor(() => document.querySelector('[aria-label="Completion unknown"]'));
    await finish();
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('ex-turn .work')), true);
    const incomplete = tool(23);
    await scroll(incomplete + ' .head');
    await hideReminder();
    await capture.click(incomplete + ' .head');
    await finish();
    assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .verb').textContent, incomplete), 'Attempted to run');
    await scroll(incomplete);
    await finish();
    yield { name: `${theme}-completion-unknown`, selector: incomplete, inspect: [incomplete] };
    await capture.reducedMotion(false);
  }
}
