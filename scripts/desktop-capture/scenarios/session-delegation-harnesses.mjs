import assert from 'node:assert/strict';

export default async function* (capture) {
  await capture.evaluate(() => {
    if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace';
  });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-connected-workspace-demo', demo => demo.fixture.delegationScene('harnesses'));
  await capture.waitFor(() => document.querySelector('[data-session-id="101"] .title')?.textContent.includes('Coordinate'));
  await capture.component('ex-machine-workspace', workspace => workspace.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelectorAll('ex-agent-work-board .agent').length === 5);
  const providers = await capture.evaluate(() => [...new Set([...document.querySelectorAll('ex-agent-work-board .agent ex-agent-mark')]
    .map(mark => mark.getAttribute('data-harness')))].sort());
  assert.deepEqual(providers, ['claude', 'codex', 'opencode', 'pi']);
  const claude = 'ex-agent-work-board .agent[data-state="completed"]:has(ex-agent-mark[data-harness="claude"])';
  assert.equal(await capture.evaluate(selector => document.querySelector(selector + ' .model')?.textContent, claude), 'Sonnet');
  const row = 'ex-agent-work-board [data-agent-source="205"]';
  for (const [theme, width, height, reduced] of [['light', 1360, 920, false], ['dark', 740, 920, true]]) {
    await capture.theme(theme);
    await capture.viewport(width, height);
    await capture.reducedMotion(reduced);
    const target = row + ' .primary-action';
    await capture.waitFor(selector => {
      const control = document.querySelector(selector);
      if (!control?.checkVisibility() || control.closest('[inert]')) return false;
      const rect = control.getBoundingClientRect();
      return rect.height > 0 && control.closest('ex-agent-work-board').getBoundingClientRect().height > 100;
    }, target);
    await capture.evaluate(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center' }), target);
    await capture.settle();
    await capture.waitFor(selector => {
      const control = document.querySelector(selector);
      const rect = control?.getBoundingClientRect();
      return !!rect && control.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }, target);
    const layout = await capture.evaluate((selector) => {
      const row = document.querySelector(selector);
      const bounds = row.getBoundingClientRect();
      const title = row.querySelector('.agent-title');
      const open = row.querySelector('.primary-action');
      const model = row.querySelector('.model');
      return {
        width: bounds.width,
        truncated: title.scrollWidth > title.clientWidth,
        contained: [...row.querySelectorAll('.status, button')].every(element => {
          const rect = element.getBoundingClientRect();
          return !rect.width || rect.left >= bounds.left && rect.right <= bounds.right;
        }),
        fullName: open.getAttribute('aria-label').includes(title.textContent),
        openLabel: open.textContent.trim(),
        elapsed: row.querySelector('.elapsed').checkVisibility(),
        model: model.textContent,
        modelFits: model.scrollWidth <= model.clientWidth,
      };
    }, row);
    assert.equal(layout.contained, true);
    assert.equal(layout.fullName, true);
    assert.equal(layout.openLabel, 'Open');
    assert.equal(layout.elapsed, true);
    assert.equal(layout.model, 'claude-sonnet · High');
    if (reduced) {
      assert.ok(layout.width <= 420);
      assert.equal(layout.truncated, true);
    } else {
      assert.equal(layout.modelFits, true);
    }
    yield { name: theme + '-four-harnesses', inspect: ['ex-agent-work-board', row], metadata: { layout } };

    await capture.evaluate(selector => document.querySelector(selector + ' .stop').focus(), row);
    await capture.press('Tab');
    await capture.waitFor(selector => document.activeElement?.matches(selector), target);
    await capture.settle();
    yield { name: theme + '-open-session-focus', inspect: [row, target] };
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('.delegation-breadcrumb')?.textContent.includes('provider fallback path'));
    await capture.click('.delegation-breadcrumb button');
    await capture.waitFor(selector => document.activeElement?.closest('[data-work-step]')?.querySelector(selector), target);
  }
}
