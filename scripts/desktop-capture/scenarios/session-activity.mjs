import assert from 'node:assert/strict';

/** Session-bar background work and runtime events, driven through the preview chat feed. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', c => c.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-agent-picker > button')?.disabled === false);
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const work = () => ({
    running: [
      { id: 'task:reviewer', kind: 'agent', label: 'Review concurrency boundary · Explore', detail: 'Reading src/payments/retry-claims.ts', startedAt: ago(4 * 60_000 + 12_000), stoppable: true, orphaned: false, tokens: 18_400, toolUses: 9 },
      { id: 'task:watch', kind: 'task', label: 'pnpm test --watch payments', detail: 'Last used Bash', startedAt: ago(41 * 60_000), stoppable: true, orphaned: true },
    ],
    recent: [
      { id: 'hook:fmt', kind: 'hook', tone: 'danger', title: 'PostToolUse:Edit hook failed', detail: 'exit 2\nprettier: src/payments/client.ts: SyntaxError: Unexpected token (42:7)', at: ago(90_000) },
      { id: 'finished:task:docs', kind: 'finished', tone: 'success', title: 'Update API notes finished', detail: 'Documented the 24-hour retry claim window.', at: ago(12 * 60_000) },
      { id: 'compaction:1', kind: 'compaction', tone: 'info', title: 'Context compacted', detail: '182k → 41.2k tokens · Automatic', at: ago(38 * 60_000) },
    ],
  });
  const publish = value => capture.component('ex-connected-workspace-demo', (c, value) => c.fixture.chat.work(value, 101, 'claude'), value);
  const trigger = () => capture.evaluate(() => {
    const button = document.querySelector('.session-bar ex-session-activity .trigger');
    return button && { mode: button.dataset.mode, text: button.textContent.replace(/\s+/g, ' ').trim(), label: button.getAttribute('aria-label') };
  });
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running'));
  };
  const open = async () => {
    await capture.click('.session-bar ex-session-activity .trigger');
    await capture.waitFor(() => !!document.querySelector('.cdk-overlay-container ex-session-activity, .cdk-overlay-container .panel'));
    await finish();
  };
  const close = async () => {
    await capture.press('Escape');
    await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));
    assert.equal(await capture.evaluate(() => document.activeElement === document.querySelector('.session-bar ex-session-activity .trigger')), true);
  };

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.viewport(1440, 960); await capture.reducedMotion(false);
    await publish({ running: [], recent: [] });
    await capture.waitFor(() => !document.querySelector('.session-bar ex-session-activity .trigger'));
    assert.equal(await capture.evaluate(() => document.querySelector('.session-bar .status')?.textContent.trim()), 'Ready');

    await publish(work());
    await capture.waitFor(() => document.querySelector('.session-bar ex-session-activity .trigger')?.dataset.mode === 'running');
    const running = await trigger();
    assert.match(running.text, /^2 in background ?41m$/);
    assert.match(running.label, /Delegated work: 2 active, longest 41m/);
    // An idle reply with live background work is not "Ready".
    assert.equal(await capture.evaluate(() => document.querySelector('.session-bar .status')?.textContent.trim()), 'Working in background');
    await finish();
    yield { name: theme + '-activity-running', selector: '.session-bar', inspect: ['.session-bar', 'ex-session-activity .trigger'] };

    await open();
    const panel = await capture.evaluate(() => {
      const root = document.querySelector('.cdk-overlay-container .panel');
      return {
        role: root?.getAttribute('role'),
        sections: [...root.querySelectorAll('.overline')].map(e => e.textContent.trim()),
        stops: [...root.querySelectorAll('.work button')].map(e => e.getAttribute('aria-label')),
        orphan: !!root.querySelector('.tag'),
        events: [...root.querySelectorAll('.event .label')].map(e => e.textContent.trim()),
      };
    });
    assert.equal(panel.role, 'dialog');
    assert.deepEqual(panel.sections, ['In progress', 'Recent']);
    assert.deepEqual(panel.stops, ['Stop Review concurrency boundary · Explore', 'Stop pnpm test --watch payments']);
    assert.equal(panel.orphan, true);
    assert.deepEqual(panel.events, ['PostToolUse:Edit hook failed', 'Update API notes finished', 'Context compacted']);
    yield { name: theme + '-activity-panel', inspect: ['.cdk-overlay-container .panel', '.session-bar'] };

    await capture.click('.cdk-overlay-container .panel button[aria-label="Stop pnpm test --watch payments"]');
    await capture.waitFor(() => document.querySelectorAll('.cdk-overlay-container .panel .work').length === 1
      && document.querySelector('.cdk-overlay-container .panel .event .label')?.textContent.trim() === 'pnpm test --watch payments stopped');
    await finish();
    assert.equal((await trigger()).text.startsWith('1 in background'), true);
    yield { name: theme + '-activity-stopped', inspect: ['.cdk-overlay-container .panel'] };
    await close();

    // Opening acknowledged the failure; a fresh one flags the trigger again.
    await publish({ running: [], recent: [{ id: 'hook:new', kind: 'hook', tone: 'danger', title: 'Stop hook failed', detail: 'exit 1\nnotify-send: not found', at: new Date().toISOString() }, ...work().recent] });
    await capture.waitFor(() => document.querySelector('.session-bar ex-session-activity .trigger')?.dataset.mode === 'issue');
    assert.equal((await trigger()).text, '1 issue');
    assert.equal(await capture.evaluate(() => document.querySelector('.session-bar .status')?.textContent.trim()), 'Ready');
    await finish();
    yield { name: theme + '-activity-issue', selector: '.session-bar', inspect: ['.session-bar', 'ex-session-activity .trigger'] };
    await open(); await close();
    await capture.waitFor(() => document.querySelector('.session-bar ex-session-activity .trigger')?.dataset.mode === 'quiet');
    assert.equal((await trigger()).label, 'Recent activity');

    await publish(work());
    await capture.viewport(760, 760); await capture.reducedMotion(true);
    await capture.waitFor(() => document.querySelector('.session-bar ex-session-activity .trigger')?.dataset.mode === 'running');
    await open();
    yield { name: theme + '-activity-narrow', inspect: ['.cdk-overlay-container .panel', '.session-bar'] };
    await close();
  }
  await publish({ running: [], recent: [] });
}
