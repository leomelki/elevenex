import assert from 'node:assert/strict';

/** Trusted mouse gestures exercise the native drag loop. Never flush Angular
 * through the component debug API between mouse-up and the release assertions. */
export default async function* (capture) {
  await capture.waitFor(() => document.querySelector('ex-connected-workspace-demo ex-task-list'));
  const point = selector => capture.evaluate(selector => {
    const bounds = document.querySelector(selector).getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }, selector);
  for (const theme of ['light', 'dark']) for (const reduced of [false, true]) {
    await capture.theme(theme);
    await capture.reducedMotion(reduced);
    await capture.viewport(reduced ? 940 : 1440, reduced ? 640 : 960);
    await capture.component('ex-connected-workspace-demo', component => component.fixture.nestingScene());
    await capture.component('ex-machine-workspace', async component => {
      await component.store.refresh();
      await component.store.loadSessionChildren({ taskId: '11', sessionId: '101' });
      component.store.selectSession({ taskId: '11', sessionId: '107' });
    });
    await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(true));
    await capture.waitFor(() => document.querySelector('ex-task-list').getAnimations({ subtree: true })
      .every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.evaluate(() => {
      const events = [];
      const record = event => {
        const row = document.querySelector('[data-session-root="106"] .branch-row');
        const button = row?.querySelector('.select');
        events.push({ type: event.type, trusted: event.isTrusted,
          dragging: !!document.querySelector('.dragging, .drag-source, .unavailable, .outdent-preview'),
          opacity: row && getComputedStyle(row).opacity,
          buttonOpacity: button && getComputedStyle(button).opacity,
          cursor: button && getComputedStyle(button).cursor });
      };
      for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, record, true);
      window.sessionReleaseProbe = { events, cleanup: () => {
        for (const type of ['dragstart', 'drop', 'dragend']) document.removeEventListener(type, record, true);
      } };
    });
    const cursors = [];
    const cursorChanged = (_event, type) => cursors.push(type);
    capture.window.webContents.on('cursor-changed', cursorChanged);
    try {
      const source = await point('[data-session-id="106"] .select');
      let target = await point('[data-session-id="101"] .select');
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source });
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...source, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 10; step++) await capture.cdp('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: source.x + (target.x - source.x) * step / 10,
        y: source.y + (target.y - source.y) * step / 10, button: 'left', buttons: 1,
      });
      // Edge scrolling can move the narrow outline during the initial lift.
      // Re-aim at its live root before releasing the physical mouse button.
      target = await point('[data-session-id="101"] .select');
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target, button: 'left', buttons: 1 });
      await capture.waitFor(() => document.querySelector('.dragging') && document.querySelector('[data-session-root="101"].drop-active'));
      const name = `${theme}-${reduced ? 'reduced' : 'desktop'}`;
      yield { name: `${name}-grabbed`, inspect: ['.drag-source', '.drop-active', 'ex-session-drag-preview'] };
      await capture.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 });
      const events = await capture.evaluate(() => window.sessionReleaseProbe.events);
      assert.deepEqual(events.map(event => event.type), ['dragstart', 'drop', 'dragend']);
      assert.ok(events.every(event => event.trusted));
      // Inspect inside native dragend, before Angular's scheduled paint can
      // conceal a deferred release. The backend reply is still held.
      assert.deepEqual(events.at(-1), { type: 'dragend', trusted: true, dragging: false,
        opacity: '1', buttonOpacity: '1', cursor: 'pointer' });
      await capture.settle();
      assert.notEqual(cursors.at(-1), 'grabbing');
      yield { name: `${name}-released`, inspect: ['[data-session-root="106"]'], metadata: { events, cursors } };
      await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(false));
      await capture.waitFor(() => document.querySelector('.children [data-session-id="106"]'));
    } finally {
      capture.window.webContents.removeListener('cursor-changed', cursorChanged);
      await capture.evaluate(() => { window.sessionReleaseProbe.cleanup(); delete window.sessionReleaseProbe; });
      await capture.component('ex-connected-workspace-demo', component => component.fixture.holdSessionMoves(false));
    }
  }
}
