import assert from 'node:assert/strict';

const task = '[data-task-id="11"]';
const nested = task + ' [data-session-root="101"]';
const footer = 'ex-workspace-navigation footer';
const summary = 'ex-workspace-navigation ex-status-summary';

/** A backend revision must leave an expanded child window stable through reads and failures. */
export default async function* (capture) {
  await capture.waitFor(() => document.readyState === 'complete');
  await capture.evaluate(() => { if (location.pathname !== '/connected-workspace') location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  for (const [theme, width, reduced] of [['light', 1440, false], ['dark', 980, true]]) {
    await capture.theme(theme);
    await capture.viewport(width, 660);
    await capture.reducedMotion(reduced);
    if (theme === 'light') {
      await capture.component('ex-connected-workspace-demo', demo => {
        demo.fixture.nestingScene();
        demo.fixture.manyChildren();
      });
      await capture.component('ex-machine-workspace', async owner => {
        await owner.store.selectProject('2');
        await owner.store.selectProject('1');
      });
      await capture.waitFor(selector => {
        const button = document.querySelector(selector);
        return button && !button.closest('[inert]');
      }, nested + ' > .branch-row > .disclosure');
      await capture.evaluate(selector => document.querySelector(selector)?.focus(), nested + ' > .branch-row > .disclosure');
      await capture.press('Enter');
      await capture.waitFor(selector => [...document.querySelectorAll(selector + ' button')]
        .some(button => button.textContent.trim() === 'Earlier child sessions' && !button.disabled), nested);
      const earlier = nested + ' button.earlier';
      await capture.evaluate(selector => document.querySelector(selector)?.focus({ preventScroll: true }), earlier);
      await capture.press('Enter');
      await capture.waitFor(selector => [...document.querySelectorAll(selector + ' button')]
        .some(button => button.textContent.trim() === 'Latest child sessions' && !button.disabled), nested);
      await capture.component('ex-machine-workspace', owner => owner.store.selectSession({ taskId: '11', sessionId: '424' }));
      await capture.evaluate(selector => document.querySelector(selector)?.focus({ preventScroll: true }), nested + ' .child-cap');
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector)?.textContent.includes('Show fewer'), nested + ' .child-cap');
    }
    await capture.waitFor(() => document.getAnimations().every(animation =>
      !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));

    assert.equal(await capture.evaluate(selector => {
      const group = document.querySelector(selector);
      return [...group.querySelectorAll('button')].every(button =>
        button.getBoundingClientRect().right <= group.getBoundingClientRect().right + 0.5);
    }, summary), true, 'Keep all status filters within the sidebar');

    const probe = await capture.component('ex-connected-workspace-demo', async (demo, selector) => {
      const fixture = demo.fixture, read = fixture.workspaceSessions;
      const list = document.querySelector('ex-workspace-navigation ex-task-list');
      const branch = document.querySelector(selector);
      const rows = () => [...branch.querySelectorAll('[data-session-id]')].filter(row => !row.closest('[inert]'));
      list.scrollTop = 120;
      await new Promise(requestAnimationFrame);
      const before = rows().map(row => [row, row.getBoundingClientRect().y]);
      const scrollTop = list.scrollTop;
      const height = list.scrollHeight;
      const button = [...branch.querySelectorAll('button')].find(button => button.textContent.trim() === 'Latest child sessions');
      button.focus({ preventScroll: true });
      const violations = new Set(), cursors = [];
      let completed = 0, fail = true;
      fixture.workspaceSessions = async (scope, query) => {
        if (query.parentSessionId !== 101) return read(scope, query);
        cursors.push(query.cursor ?? null);
        await new Promise(resolve => setTimeout(resolve, 200));
        const result = fail ? { ok: false, error: { code: 'transport', message: 'Temporary child read failure' } } : await read(scope, query);
        completed++;
        return result;
      };
      const observe = async target => {
        fixture.liveSessionStatus(102, 'done');
        window.dispatchEvent(new window.Event('focus'));
        const deadline = performance.now() + 3000;
        let settledFrames = 0;
        do {
          await new Promise(requestAnimationFrame);
          if (branch.querySelector('[role="status"], [role="alert"]')) violations.add('loading or error flashed');
          if (button.disabled || document.activeElement !== button) violations.add('page control or focus changed');
          const current = rows();
          if (current.length !== before.length || before.some(([row, y], index) =>
            row !== current[index] || Math.abs(row.getBoundingClientRect().y - y) > 0.5)) violations.add('child rows moved or remounted');
          if (list.scrollHeight !== height || list.scrollTop !== scrollTop) violations.add('sidebar scroll changed');
          if (completed >= target) settledFrames++;
        } while (settledFrames < 4 && performance.now() < deadline);
      };
      try {
        // Invalidate through the workspace reader without changing the fixture's rows.
        // Both the failed read and its successful successor should preserve the older page.
        await observe(1);
        fail = false;
        await observe(2);
        return { completed, cursors, scrollTop, violations: [...violations] };
      } finally {
        fixture.workspaceSessions = read;
      }
    }, nested);
    assert.equal(probe.completed, 2, JSON.stringify(probe));
    assert.deepEqual(probe.cursors, ['0:425', '0:425'], JSON.stringify(probe));
    assert.ok(probe.scrollTop > 0, 'Exercise a scrolled sidebar');
    assert.deepEqual(probe.violations, []);
    yield { name: theme + '-older-children-stable', inspect: [nested, summary, footer], metadata: probe };
  }
}
