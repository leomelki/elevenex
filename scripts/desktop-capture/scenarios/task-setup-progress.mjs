import assert from 'node:assert/strict';

const root = 'ex-task-setup-demo';
const inspect = [`${root} ex-workspace-task-setup section`, `${root} ex-step-list`, `${root} ex-task-list`, `${root} ex-task-signal`];

/** Workspace setup steps and sidebar lifecycle signals, in both themes and narrow reduced motion. Run against `pnpm desktop:preview`. */
export default async function* (capture) {
  await capture.evaluate(() => { if (location.pathname !== '/task-setup') location.href = '/task-setup'; });
  await capture.waitFor(() => document.querySelector('ex-task-setup-demo ex-step-list'));
  const moment = async name => {
    await capture.component(root, (component, value) => component.moment.set(value), name);
    await capture.settle();
  };
  const steps = () => capture.evaluate(() => Array.from(document.querySelectorAll('ex-task-setup-demo ex-step-list li'), item =>
    item.classList.contains('active') ? 'active' : item.classList.contains('failed') ? 'failed' : item.classList.contains('todo') ? 'todo' : 'done'));

  for (const theme of ['light', 'dark']) {
    await capture.theme(theme); await capture.reducedMotion(false); await capture.viewport(1100, 720);
    await moment('fetching');
    assert.deepEqual(await steps(), ['active', 'todo', 'todo']);
    yield { name: `${theme}-fetching`, inspect };
    await moment('waiting');
    assert.match(await capture.evaluate(() => document.querySelector('ex-task-setup-demo li.active')?.textContent ?? ''), /one at a time/);
    yield { name: `${theme}-waiting`, inspect };
    await moment('checkout');
    assert.deepEqual(await steps(), ['done', 'active', 'todo']);
    yield { name: `${theme}-checkout`, inspect };
    await moment('failed');
    assert.deepEqual(await steps(), ['done', 'failed', 'todo']);
    assert.ok(await capture.evaluate(() => !!document.querySelector('ex-task-setup-demo [role="alert"]')));
    yield { name: `${theme}-failed`, inspect };
    await moment('legacy');
    assert.ok(await capture.evaluate(() => !document.querySelector('ex-task-setup-demo ex-step-list') && !!document.querySelector('ex-task-setup-demo ex-workspace-task-setup ex-progress-line')));
    yield { name: `${theme}-older-runtime`, inspect };
  }

  // Sidebar labels never overlap or push the title off its row.
  const rows = await capture.evaluate(() => Array.from(document.querySelectorAll('ex-task-setup-demo ex-task-list header'), header => {
    const title = header.querySelector('.title')?.getBoundingClientRect(), signal = header.querySelector('ex-task-signal')?.getBoundingClientRect();
    return { text: header.querySelector('ex-task-signal')?.textContent?.trim() ?? '', overlap: !!title && !!signal && title.right > signal.left + 1 && signal.width > 0, height: header.getBoundingClientRect().height };
  }));
  assert.ok(rows.some(row => row.text.includes('Needs setup')) && rows.some(row => row.text.includes('Close failed')) && rows.some(row => row.text.includes('No workspace')));
  assert.ok(rows.every(row => !row.overlap && row.height <= 36), JSON.stringify(rows));

  await capture.theme('light'); await capture.reducedMotion(true); await capture.viewport(420, 820);
  await moment('checkout');
  yield { name: 'light-narrow-reduced-motion', inspect };
}
