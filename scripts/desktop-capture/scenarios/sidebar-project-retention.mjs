import assert from 'node:assert/strict';

/** Surviving tasks never exit or remount while the next project page loads. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('[data-task-id="12"]'));
  const owner = (fn, data) => capture.component('ex-machine-workspace', fn, data);
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
  };
  await capture.waitFor(() => {
    const article = document.querySelector('[data-task-id="12"]');
    return article && !article.closest('[inert]') && article.getBoundingClientRect().height > 30;
  });
  await finish();
  await capture.click('[data-task-id="12"] header .toggle');
  await finish();
  for (const [theme, reduced] of [['light', false], ['dark', false], ['dark', true]]) {
    await capture.theme(theme); await capture.reducedMotion(reduced);
    await capture.viewport(reduced ? 920 : 1440, 900);
    for (const selected of [false, true]) {
      // Selecting the other project must not determine which matching rows survive.
      if (selected) await owner(component => component.store.selectSession({taskId: '13', sessionId: '104'}));
      await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskDelay(450));
      for (const projectId of ['1', 'all']) {
        const probe = await owner(async (component, id) => {
          const articles = ['11', '12'].map(id => document.querySelector(`[data-task-id="${id}"]`));
          const sessionRows = articles.map(article => [...article.querySelectorAll('ex-session-row')]);
          const folds = articles.map(article => article.closest('ex-task-group').closest('ex-fold'));
          const expanded = articles.map(article => article.querySelector('header .toggle').getAttribute('aria-expanded'));
          const layout = () => {
            const root = document.querySelector('ex-workspace-navigation');
            const header = root.querySelector('.sidebar > header').getBoundingClientRect();
            const title = document.createRange();
            title.selectNodeContents(root.querySelector('h1'));
            const text = title.getBoundingClientRect();
            return {
              headerHeight: header.height,
              titleX: text.x, titleY: text.y,
              newTaskY: root.querySelector('button[aria-label="New task"]').getBoundingClientRect().y,
              summaryY: root.querySelector('ex-status-summary').getBoundingClientRect().y,
              tasksY: root.querySelector('ex-task-list').getBoundingClientRect().y,
            };
          };
          const initialLayout = layout();
          const violations = [];
          const sample = () => {
            for (const [key, value] of Object.entries(layout())) {
              if (Math.abs(value - initialLayout[key]) > 0.5) violations.push(`layout: ${key}`);
            }
            articles.forEach((article, index) => {
              if (!article.isConnected || document.querySelector(`[data-task-id="${article.dataset.taskId}"]`) !== article) violations.push('task identity');
              if (!folds[index].classList.contains('open') || folds[index].hasAttribute('inert')) violations.push('task exit');
              if (article.querySelector('header .toggle').getAttribute('aria-expanded') !== expanded[index]) violations.push('disclosure');
              if (sessionRows[index].some(row => !row.isConnected)) violations.push('session identity');
            });
          };
          const observer = new window.MutationObserver(sample);
          observer.observe(document.querySelector('ex-task-list'), {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'inert', 'aria-expanded']});
          const start = performance.now();
          let frames = 0, loadingFrames = 0;
          try {
            const pending = component.store.selectProject(id);
            do {
              await new Promise(requestAnimationFrame);
              sample(); frames++;
              if (component.store.loading()) loadingFrames++;
            } while (component.store.loading());
            await pending; sample();
            return {violations: [...new Set(violations)], frames, loadingFrames, duration: performance.now() - start, expanded, initialLayout, finalLayout: layout()};
          } finally { observer.disconnect(); }
        }, projectId);
        assert.deepEqual(probe.violations, []);
        assert.ok(probe.loadingFrames > 5, 'Sample loading beyond the old exit cleanup deadline');
        assert.ok(probe.duration >= 400);
        assert.deepEqual(probe.expanded, ['true', 'false']);
        await finish();
        assert.equal(await capture.evaluate(() => !!document.querySelector('[data-task-id="13"]')), projectId === 'all');
        yield {name: `${theme}-${reduced ? 'reduced' : 'motion'}-${selected ? 'selected-other' : 'unselected'}-${projectId}`, inspect: ['ex-workspace-navigation', '[data-task-id="11"]', '[data-task-id="12"]'], metadata: probe};
      }
      await capture.component('ex-connected-workspace-demo', component => component.fixture.setTaskDelay(0));
    }
  }
}
