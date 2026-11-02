import assert from 'node:assert/strict';

const rail = id => id === 'all' ? 'ex-project-rail .all' : `ex-project-rail [data-project-id="${id}"]`;
const taskIds = id => id === 'all' ? ['11', '12', '13'] : id === '1' ? ['11', '12'] : ['13'];

/** Check real frame geometry through disjoint and overlapping project reads. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('[data-task-id="13"]'));
  const finish = async () => {
    await capture.waitFor(() => document.querySelector('ex-workspace-navigation .sidebar')?.getAttribute('aria-busy') === 'false');
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  await finish();
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(false);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskDelay(450));
    let from = 'all';
    for (const to of ['1', '2', '1', 'all', '2', 'all']) {
      // Arm before trusted input so even the first exit frame is observed.
      await capture.evaluate(({ before, after, target }) => {
        const list = document.querySelector('ex-task-list');
        const originals = new Map(before.map(id => [id, document.querySelector(`[data-task-id="${id}"]`)]));
        const initial = Object.fromEntries([...originals].map(([id, row]) => [id, row.closest('ex-task-group').closest('ex-fold').getBoundingClientRect().height]));
        window.sidebarSwitchProbe = new Promise(resolve => {
          const frames = [];
          let start;
          const sample = () => {
            const selected = document.querySelector(target)?.getAttribute('aria-current') === 'true';
            if (selected && start === undefined) start = performance.now();
            if (start !== undefined) {
              const rows = Object.fromEntries([...new Set([...before, ...after])].map(id => {
                const row = document.querySelector(`[data-task-id="${id}"]`);
                const fold = row?.closest('ex-task-group').closest('ex-fold');
                return [id, { connected: !!row, same: !originals.has(id) || row === originals.get(id), height: fold?.getBoundingClientRect().height ?? 0, inert: !!fold?.hasAttribute('inert') }];
              }));
              frames.push({ t: performance.now() - start, listSame: document.querySelector('ex-task-list') === list, rows });
              if (performance.now() - start > 1100) { resolve({ initial, frames }); return; }
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }, { before: taskIds(from), after: taskIds(to), target: rail(to) });
      await capture.click(rail(to));
      const probe = await capture.evaluate(async () => {
        const result = await window.sidebarSwitchProbe;
        delete window.sidebarSwitchProbe;
        return result;
      });
      assert(probe.frames.length > 10);
      assert(probe.frames.every(frame => frame.listSame), `${from} → ${to}: retain the outline through loading`);
      for (const id of taskIds(from)) {
        if (taskIds(to).includes(id)) {
          assert(probe.frames.every(frame => frame.rows[id].same && !frame.rows[id].inert), `${id}: overlapping task stays open`);
        } else {
          assert(probe.frames.some(frame => frame.rows[id].connected && frame.rows[id].inert && frame.rows[id].height > 1 && frame.rows[id].height < probe.initial[id] - 1), `${id}: outgoing task visibly collapses`);
          assert.equal(probe.frames.at(-1).rows[id].connected, false);
        }
      }
      for (const id of taskIds(to).filter(id => !taskIds(from).includes(id))) {
        const final = probe.frames.at(-1).rows[id].height;
        assert(final > 30);
        assert(probe.frames.some(frame => frame.rows[id].connected && frame.rows[id].height > 1 && frame.rows[id].height < final - 1), `${id}: incoming task visibly opens`);
      }
      await finish();
      yield { name: `${theme}-${from}-to-${to}`, inspect: ['ex-workspace-navigation'], metadata: probe };
      from = to;
    }
    // Reverse within the exit, then again before the stale read returns.
    await capture.click(rail('1')); await finish();
    await capture.evaluate(() => { document.querySelector('[data-task-id="11"]').dataset.retained = 'yes'; });
    await capture.click(rail('2'));
    // The destination read returns before the exit completes; the superseded
    // slow request must not later replace its rows with the other project.
    await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskDelay(0));
    await capture.click(rail('all'));
    await capture.click(rail('1'));
    await finish();
    assert.equal(await capture.evaluate(() => document.querySelector('[data-task-id="11"]')?.dataset.retained), 'yes');
    assert.deepEqual(await capture.evaluate(() => [...document.querySelectorAll('ex-task-group [data-task-id]')].map(row => row.dataset.taskId)), ['11', '12']);
    yield { name: `${theme}-interrupted-round-trip`, inspect: ['ex-workspace-navigation'] };
    await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskDelay(450));
    await capture.click(rail('all')); await finish();
  }
  await capture.reducedMotion(true); await capture.viewport(920, 760);
  for (const to of ['1', '2', 'all']) {
    await capture.click(rail(to)); await finish();
    assert.deepEqual(await capture.evaluate(() => [...document.querySelectorAll('ex-task-group [data-task-id]')].map(row => row.dataset.taskId)), taskIds(to));
    yield { name: `narrow-reduced-${to}`, inspect: ['ex-workspace-navigation'] };
  }
}
