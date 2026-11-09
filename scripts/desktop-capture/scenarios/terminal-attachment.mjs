import assert from 'node:assert/strict';

/** Production TaskTerminalComponent, xterm and input with preview-only transport. */
export default async function* (capture) {
  await capture.evaluate(() => { location.href = '/terminal-stream'; });
  await capture.waitFor(() => document.querySelector('.xterm-helper-textarea') &&
    !window.ng.getComponent(document.querySelector('ex-task-terminal')).attached?.surface.terminal.options.disableStdin);
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    await capture.reducedMotion(theme === 'dark');
    await capture.viewport(theme === 'dark' ? 420 : 900, 600);
    await capture.settle();
    assert.equal(await capture.evaluate(() => document.querySelector('ex-task-terminal [aria-label="Terminal options"], ex-terminal-preferences')), null,
      'Task terminals have no options dropdown or settings sheet, even when the engine supports untracked shells');
    assert.equal(await capture.evaluate(() => !!document.querySelector('ex-task-terminal [aria-label="New terminal (⌘T)"]')), true,
      'Direct terminal creation stays available');
    await capture.click('.surface .xterm');
    await capture.component('ex-task-terminal', component => {
      component.captureNode = component.attached.surface.terminal.element;
      component.captureFocus = document.activeElement;
      if (!component.captureNode.contains(component.captureFocus)) throw new Error('Terminal did not receive focus');
    });
    const baseline = await capture.component('ex-terminal-stream-demo', component => ({ ...component.platform.counts }));
    assert.equal(baseline.create, 1);
    for (let index = 1; index <= 8; index++) {
      await capture.component('ex-terminal-stream-demo', (component, index) => component.platform.update(index), index);
      await capture.component('ex-task-terminal', async component => {
        await component.attached.stream.settled();
        if (component.attached.surface.terminal.element !== component.captureNode || document.activeElement !== component.captureFocus)
          throw new Error('Metadata/output replaced the terminal or lost focus');
      });
    }
    await capture.press('x');
    await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-terminal-stream-demo')).platform.counts.writes > 0);
    const retained = await capture.component('ex-terminal-stream-demo', component => ({ ...component.platform.counts }));
    assert.equal(retained.attach, baseline.attach);
    assert.equal(retained.detach, baseline.detach);
    assert.equal(retained.writes, baseline.writes + 1);
    yield { name: `${theme}-retained-focus-input`, selector: 'ex-task-terminal', metadata: retained };

    await capture.component('ex-terminal-stream-demo', component => component.platform.interrupt());
    await capture.waitFor(() => !window.ng.getComponent(document.querySelector('ex-task-terminal')).attached.surface.terminal.options.disableStdin);
    const recovered = await capture.component('ex-terminal-stream-demo', component => ({ ...component.platform.counts }));
    assert.equal(recovered.attach, baseline.attach + 1);
    assert.equal(recovered.detach, baseline.detach + 1);
    assert.equal(recovered.create, 1);
    assert.equal(await capture.component('ex-task-terminal', component => component.attached.surface.terminal.element === component.captureNode), true);
    await capture.press('y');
    const input = await capture.component('ex-terminal-stream-demo', component => component.platform.counts.writes);
    assert.equal(input, retained.writes + 1);
    yield { name: `${theme}-recovered`, selector: 'ex-task-terminal', metadata: recovered };
  }
}
