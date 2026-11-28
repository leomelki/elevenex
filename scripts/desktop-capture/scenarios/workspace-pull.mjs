import assert from 'node:assert/strict';

const summary = {
  taskId: 11,
  branch: 'fix/payments/idempotent-retries-with-extended-observability',
  upstream: 'team-remote/releases/payment-gateway/idempotent-retries',
  behind: 3, ahead: 0, files: 2, additions: 24, deletions: 6, conflicted: false,
};
const header = 'ex-workspace-task-header';
const pull = `${header} button.pull`;
const commit = `${header} ex-git-bar button.primary`;

export default async function* (capture) {
  const preview = (fn, data) => capture.component('ex-connected-workspace-demo', fn, data);
  const seed = async changes => {
    await preview((component, value) => component.fixture.setGitSummary(value), { ...summary, ...changes });
    await capture.component(header, component => component.git.refresh());
  };
  const label = value => capture.waitFor((selector, text) => document.querySelector(selector)?.getAttribute('aria-label') === text, pull, value);
  const focus = selector => capture.evaluate(value => document.querySelector(value).focus(), selector);
  const tooltip = text => capture.waitFor(value => document.querySelector('ex-tooltip')?.textContent.includes(value), text);
  const inspect = [header, pull, commit, `${header} .stat-slot button`, 'ex-tooltip'];

  await capture.viewport(1440, 960);
  await capture.theme('light');
  await capture.evaluate(() => {
    if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace';
  });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await preview((component, value) => component.fixture.setGitSummary(value), summary);
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await label('Pull 3 commits');
  await focus(pull);
  await tooltip(`${summary.upstream} → ${summary.branch}`);
  yield { name: 'light-upstream-direction', inspect };

  await capture.press('Escape');
  await capture.click(`${header} button.more`);
  await capture.waitFor(() => document.querySelector('[role="menuitem"]')?.textContent.includes('Commit and push'));
  assert.equal(await capture.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => /sync|pull/i.test(item.textContent))), false);
  await capture.press('Escape');

  await preview(component => component.fixture.setGitActionHeld(true));
  await focus(pull);
  await capture.press('Enter');
  await label('Pulling…');
  assert.equal(await capture.evaluate(selector => document.activeElement === document.querySelector(selector), pull), true);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).disabled, commit), true);
  await capture.press('Enter');
  assert.deepEqual(await preview(component => component.fixture.sentGitActions), [{ type: 'sync', taskId: 11 }]);
  yield { name: 'light-pulling', selector: header, inspect };
  await preview(component => component.fixture.setGitActionHeld(false));
  await capture.waitFor(selector => !document.querySelector(selector), pull);
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).disabled, commit), false);

  await capture.theme('dark');
  await seed({ behind: 1 });
  await label('Pull 1 commit');
  await capture.hover(pull);
  await tooltip('Pull 1 commit');
  yield { name: 'dark-single-commit', inspect };

  await preview(component => component.fixture.setGitFailure('pull'));
  await capture.click(pull);
  await capture.waitFor(() => document.querySelector('.pull-failure [role="alert"]')?.textContent.includes('Could not fast-forward'));
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).disabled, commit), false);
  const refresh = `${header} button[aria-label="Refresh Git status"]`;
  await focus(refresh);
  await tooltip('Could not fast-forward');
  yield { name: 'dark-pull-failure', inspect: [...inspect, refresh] };
  await capture.press('Enter');
  await label('Pull 1 commit');

  await capture.viewport(680, 840);
  await capture.reducedMotion(true);
  await seed({ ahead: 2 });
  await label('Diverged');
  await focus(pull);
  await tooltip('3 commits behind and 2 ahead');
  assert.equal(await capture.evaluate(selector => document.querySelector(selector).getAttribute('aria-disabled'), pull), 'true');
  yield { name: 'narrow-diverged', inspect };

  await capture.press('Escape');
  await seed({});
  await label('Pull 3 commits');
  assert.equal(await capture.evaluate(selector => getComputedStyle(document.querySelector(`${selector} .pull-copy`)).display, pull), 'none');
  assert.equal(await capture.evaluate(selector => {
    const button = document.querySelector(selector);
    const row = button.closest('.row');
    const stats = row.querySelector('.stat-slot button');
    return row.scrollWidth <= row.clientWidth && button.getBoundingClientRect().right < stats.getBoundingClientRect().left;
  }, pull), true);
  yield { name: 'narrow-pull', selector: header, inspect };
}
