import assert from 'node:assert/strict';

/** Connected new-task branch searches with trusted input and typed create receipts. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  const owner = fn => capture.component('ex-machine-workspace', fn);
  const fixture = fn => capture.component('ex-connected-workspace-demo', fn);
  const name = 'input[aria-label="Task name"]';
  const branch = 'input[aria-label="Branch: type to search or create"]';
  const source = 'input[aria-label="Start from"]';
  const list = '[role="listbox"][aria-label="Start from"]';
  const settle = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  const ready = selector => capture.waitFor(selector =>
    document.activeElement?.matches(selector) && !document.querySelector('ex-new-task [role="status"]'), selector);
  const open = async title => {
    await owner(component => component.store.openNewTask('1'));
    await ready(name); await settle();
    await capture.fill(name, title);
    await capture.press('Enter'); await ready(branch); await settle();
  };
  const selected = () => capture.evaluate(() => {
    const id = document.activeElement?.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent : null;
  });

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.viewport(theme === 'dark' ? 390 : 1280, theme === 'dark' ? 720 : 900);
    await capture.reducedMotion(theme === 'dark');
    await open(`New task from held branch ${theme}`);
    await capture.fill(branch, 'idempotent retries');
    await ready(branch); await settle();
    assert.equal(await capture.evaluate(() => {
      const input = document.activeElement;
      return Array.from(document.getElementById(input.getAttribute('aria-controls')).querySelectorAll('[role="option"]'))
        .filter(row => row.textContent.includes('In use · Make retries safe')).every(row => row.disabled)
        && document.getElementById(input.getAttribute('aria-controls')).textContent.includes('origin/fix/idempotent-retries');
    }), true);
    yield { name: `${theme}-held-target`, inspect: ['.dialog', branch, '[role="option"][aria-disabled="true"]'] };
    await capture.click('button[aria-label="Reset branch name"]');
    await capture.waitFor(() => document.querySelector('ex-new-task footer .next')?.disabled === false);
    await capture.click('ex-new-task footer .next');
    await ready(source); await settle();
    assert.match(await selected(), /origin\/main.*default.*remote/s);
    assert.equal(await capture.evaluate(selector =>
      Array.from(document.querySelectorAll(selector + ' [role="option"]')).some(row => row.textContent.includes('Task · Make retries safe') && !row.disabled), list), true);
    yield { name: `${theme}-source-choices`, inspect: ['.dialog', source, list] };

    await capture.fill(source, 'idempotent retries');
    await ready(source); await settle();
    assert.match(await selected(), /fix\/idempotent-retries.*Task · Make retries safe/s);
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-header h1')?.textContent.includes(`New task from held branch ${document.documentElement.dataset.theme}`));
    assert.equal(await fixture(component => component.fixture.sentTaskCreates.at(-1).baseRef), 'refs/heads/fix/idempotent-retries');

    await open(`Continue remote payments ${theme}`);
    await fixture(component => component.fixture.setBranchSearchFailure(true));
    await capture.fill(branch, 'no such branch');
    await capture.waitFor(() => document.querySelector('ex-new-task .branch-search-error'));
    assert.equal(await capture.evaluate(() => document.querySelector('ex-new-task footer .next').disabled), true);
    await settle();
    yield { name: `${theme}-branch-search-error`, inspect: ['.dialog', '.branch-search-error'] };
    await fixture(component => component.fixture.setBranchSearchFailure(false));
    await capture.click('.branch-search-error button');
    await ready(branch); await settle();
    assert.equal(await capture.evaluate(() => !!document.querySelector('.branch-search-error')), false);

    const remote = theme === 'light' ? 'review/payments' : 'review/settlement';
    await capture.fill(branch, remote);
    await ready(branch); await settle();
    assert.ok((await selected())?.includes(`upstream/${remote}`));
    assert.ok((await selected())?.includes('remote'));
    await capture.press('Enter');
    await capture.waitFor(() => document.activeElement?.matches('ex-new-task footer .next'));
    await settle();
    yield { name: `${theme}-remote-existing-history`, inspect: ['.dialog', '.skip-note', 'ex-new-task footer .next'] };
    await capture.press('Enter');
    await capture.waitFor(() => document.querySelector('ex-workspace-task-header h1')?.textContent.includes(`Continue remote payments ${document.documentElement.dataset.theme}`));
    const created = await fixture(component => component.fixture.sentTaskCreates.at(-1));
    assert.equal(created.mode, 'existing');
    assert.equal(created.branchName, `refs/remotes/upstream/${remote}`);
    assert.equal(created.baseRef, undefined);
  }
}
