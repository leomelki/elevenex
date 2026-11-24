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
  for (const [theme, width, height, reduced] of [['light', 1360, 920, false], ['dark', 850, 860, true]]) {
    await capture.theme(theme);
    await capture.viewport(width, height);
    await capture.reducedMotion(reduced);
    const target = 'ex-agent-work-board [data-agent-source="205"] .agent-title';
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
    if (await capture.evaluate(selector => document.querySelector(selector)?.getAttribute('aria-expanded') === 'false', target))
      await capture.click(target);
    await capture.waitFor(() => document.querySelector('ex-agent-work-board [data-agent-source="205"] .identity')?.checkVisibility());
    assert.match(await capture.evaluate(() => document.querySelector('ex-agent-work-board [data-agent-source="205"] .identity').textContent), /openrouter\/anthropic\/claude-sonnet/);
    yield { name: theme + '-four-harnesses', inspect: ['ex-agent-work-board', 'ex-agent-work-board [data-agent-source="205"]'] };
  }
}
