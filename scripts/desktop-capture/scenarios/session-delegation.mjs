import assert from 'node:assert/strict';

/** Parent-to-child and native inspector flows through the production connected workspace. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => !!document.querySelector('ex-workspace-navigation ex-task-list'));
  const phase = scene => capture.component('ex-connected-workspace-demo', (c, scene) => c.fixture.delegationScene(scene), scene);
  const select = id => capture.component('ex-machine-workspace', (c, id) =>
    c.store.selectSession({ taskId: '11', sessionId: id }), String(id));
  const finish = () => capture.waitFor(() => document.getAnimations().every(animation =>
    !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  const parentRow = '[data-session-root="101"] > .branch-row';
  const board = 'ex-agent-work-board';
  const reviewer = board + ' [data-agent-source="202"]';
  const display = selector => capture.evaluate(selector => {
    const target = document.querySelector(selector);
    target?.scrollIntoView({ block: 'center' });
  }, selector);
  await capture.viewport(1360, 920);
  await capture.theme('light');
  await phase('starting');
  await capture.waitFor(() => document.querySelector('[data-session-id="101"] .title')?.textContent.includes('Coordinate'));
  await select(101);
  await capture.waitFor(() => document.querySelector('ex-agent-work-board [data-state="pending"]')?.checkVisibility());
  await capture.evaluate(() => document.querySelector('ex-agent-work-board .agent').setAttribute('data-capture-identity', 'retained'));
  await finish();
  yield { name: 'light-starting', inspect: [board, 'ex-composer'] };

  await phase('running');
  await capture.waitFor(() => document.querySelectorAll('ex-agent-work-board .agent').length === 3);
  assert.equal(await capture.evaluate(() => document.querySelector('[data-agent-source="202"]')?.dataset.captureIdentity), 'retained');
  await display(reviewer);
  await capture.click(reviewer + ' .agent-title');
  await capture.waitFor(() => document.querySelector('[data-agent-source="202"] .sent')?.checkVisibility() &&
    document.querySelector('[data-agent-source="202"] .sent')?.textContent.includes('Queued'));
  await finish();
  yield { name: 'light-running-board', inspect: [board, reviewer, parentRow + ' .disclosure'] };

  await phase('waiting');
  await capture.waitFor(() => document.querySelector('.agent-requests button')?.checkVisibility());
  const collapse = parentRow + ' .disclosure[aria-expanded="true"]';
  if (await capture.evaluate(selector => !!document.querySelector(selector), collapse)) await capture.click(collapse);
  await capture.waitFor(() => document.querySelector('[data-session-root="101"] [data-summary="attention"]')?.checkVisibility());
  await finish();
  yield { name: 'light-needs-you', inspect: [board, '.agent-requests', parentRow] };

  await capture.theme('dark');
  await capture.click('ex-session-activity .trigger');
  await capture.waitFor(() => document.querySelector('.cdk-overlay-container .panel')?.textContent.includes('Write regression tests'));
  assert.match(await capture.evaluate(() => document.querySelector('.cdk-overlay-container .panel').textContent), /Audit the callback paths/);
  await finish();
  yield { name: 'dark-unified-activity', inspect: ['.cdk-overlay-container .panel', '.agent-requests'] };
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('.cdk-overlay-container .panel'));

  await capture.click('.agent-requests .agent-request-line > button');
  await capture.waitFor(() => document.activeElement?.matches('ex-approval-card'));
  assert.match(await capture.evaluate(() => document.querySelector('.delegation-breadcrumb').textContent), /Write regression tests/);
  assert.equal(await capture.evaluate(() => !!document.querySelector('ex-agent-assignment')), true);
  await finish();
  yield { name: 'dark-child-decision', inspect: ['.delegation-breadcrumb', 'ex-agent-assignment', 'ex-approval-card'] };
  await capture.click('.delegation-breadcrumb button');
  await capture.waitFor(() => document.querySelector('ex-agent-work-board')?.checkVisibility());
  await finish();

  await phase('reply');
  await capture.waitFor(() => document.querySelector('ex-agent-work-reply')?.checkVisibility());
  assert.match(await capture.evaluate(() => document.querySelector('ex-agent-work-board .wait-line').textContent), /Review the retry boundary replied/);
  await display('ex-agent-work-reply');
  await capture.hover('ex-agent-work-reply header strong');
  await finish();
  yield { name: 'dark-reply-handoff', inspect: [board, 'ex-agent-work-reply', 'ex-agent-work-reply .mark'] };
  await capture.click('ex-agent-work-reply footer button[aria-expanded="false"]');
  await capture.waitFor(() => document.querySelector('ex-agent-work-reply ex-markdown [aria-level="3"]')?.checkVisibility());
  await display('ex-agent-work-reply [data-agent-session="202"]');
  await capture.click('ex-agent-work-reply [data-agent-session="202"]');
  await capture.waitFor(() => document.querySelector('.handoff')?.textContent.includes('Coordinate the retry fix'));
  assert.equal(await capture.evaluate(() => document.querySelector('ex-chat').textContent.includes('[Elevenex')), false);
  await finish();
  yield { name: 'dark-returned-reply', inspect: ['.delegation-breadcrumb', 'ex-agent-assignment', '.handoff'] };
  await capture.click('.delegation-breadcrumb button');
  await capture.waitFor(() => document.activeElement?.closest('ex-agent-work-reply, [data-chat-row="wait-reply-result"]'));

  await phase('settled');
  await capture.waitFor(() => document.querySelector('.agent-outcomes .agent-chip')?.checkVisibility());
  await display('.agent-outcomes');
  await finish();
  yield { name: 'dark-settled-turn', inspect: ['.agent-outcomes', 'ex-turn footer'] };
  const inspect = '.agent-outcomes button[aria-label^="Audit the callback paths"]';
  await capture.click(inspect);
  await capture.waitFor(() => document.querySelector('.agent-dialog .pinned-result')?.checkVisibility());
  await finish();
  yield { name: 'dark-native-agent-result', inspect: ['.agent-dialog', '.pinned-result', '.agent-dialog .assignment'] };
  await capture.press('Escape');
  await capture.waitFor(() => !document.querySelector('.agent-dialog'));
  assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), inspect), true);

  await capture.viewport(850, 860);
  await capture.reducedMotion(true);
  await capture.theme('light');
  await phase('failed');
  await capture.component('ex-session-chat', c => c.latest());
  await capture.waitFor(() => document.querySelector('[data-agent-source="202"][data-state="error"]')?.checkVisibility());
  await display(reviewer);
  await capture.click(reviewer + ' .agent-title');
  await finish();
  assert.equal(await capture.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  yield { name: 'light-narrow-reduced-motion', inspect: [board, reviewer, 'ex-composer'] };
}
