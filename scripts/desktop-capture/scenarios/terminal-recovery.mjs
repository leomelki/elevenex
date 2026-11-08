import assert from 'node:assert/strict';

/** Real task-terminal owner/xterm with the isolated preview stream transport. */
export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    await capture.evaluate(() => { location.href = '/terminal-stream'; });
    await capture.theme(theme);
    await capture.reducedMotion(theme === 'dark');
    await capture.viewport(theme === 'dark' ? 360 : 900, 600);
    await capture.waitFor(() => {
      const terminal = document.querySelector('ex-task-terminal');
      return terminal && window.ng?.getComponent(terminal)?.attached?.stream?.ready;
    });
    await capture.settle();
    const geometry = () => capture.evaluate(() => {
      const rect = document.querySelector('.surface').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const before = await geometry();
    await capture.component('ex-terminal-stream-demo', component => component.platform.interrupt(true));
    await capture.waitFor(() => document.querySelector('.connection-notice'));
    assert.deepEqual(await geometry(), before, 'Paused typing must not resize or move terminal output');
    await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-task-terminal')).attached.stream?.ready);
    assert.equal(await capture.component('ex-task-terminal', component => component.inputBlocked()), true);
    const warning = await capture.evaluate(() => document.querySelector('.connection-notice').textContent);
    assert.match(warning, /Some keystrokes may not have reached/);
    yield { name: `${theme}-typing-paused`, selector: 'ex-task-terminal', inspect: ['.surface', '.connection-notice'] };

    await capture.component('ex-terminal-stream-demo', component => component.platform.interrupt());
    await capture.waitFor(() => window.ng.getComponent(document.querySelector('ex-task-terminal')).attached.stream?.ready);
    assert.equal(await capture.evaluate(() => document.querySelector('.connection-notice').textContent), warning,
      'Further reconnects must retain the paused-typing warning');
    assert.equal(await capture.component('ex-terminal-stream-demo', component => component.platform.counts.writes), 0,
      'Reconnect must never resend input');
    await capture.click('.connection-notice [aria-label="Dismiss notification"]');
    assert.equal(await capture.component('ex-task-terminal', component => component.inputBlocked()), true,
      'Dismissing the warning must not resume typing');
    assert.equal(await capture.evaluate(() => document.activeElement.textContent.trim()), 'Resume typing');
    await capture.press('Enter');
    await capture.waitFor(() => !document.querySelector('.connection-notice'));
    assert.equal(await capture.component('ex-task-terminal', component => component.inputBlocked()), false);
    assert.equal(await capture.evaluate(() => document.activeElement.classList.contains('xterm-helper-textarea')), true);
    assert.deepEqual(await geometry(), before, 'Resuming must not resize or move terminal output');
    yield { name: `${theme}-typing-resumed`, selector: 'ex-task-terminal' };

    await capture.component('ex-terminal-stream-demo', component => component.platform.interrupt());
    await capture.waitFor(() => document.querySelector('.connection-notice'));
    assert.match(await capture.evaluate(() => document.querySelector('.connection-notice').textContent), /Terminal connection lost\. Reconnecting…/);
    assert.deepEqual(await geometry(), before, 'An ordinary reconnect must not move terminal output');
    yield { name: `${theme}-reconnecting`, selector: 'ex-task-terminal' };
    await capture.waitFor(() => !document.querySelector('.connection-notice'));

    await capture.component('ex-terminal-stream-demo', component => component.platform.exit(7));
    await capture.waitFor(() => document.querySelector('ex-terminal-view .failure')?.textContent.includes('Exited 7'));
    // Wait for the failure fold to settle before testing further pane resizes.
    await capture.waitFor(() => !document.querySelector('ex-fold')?.getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
    await capture.settle();
    const failed = await capture.component('ex-terminal-stream-demo', component => ({ ...component.platform.counts }));
    await capture.viewport(theme === 'dark' ? 390 : 1000, 650);
    await capture.viewport(theme === 'dark' ? 360 : 900, 600);
    // Observe beyond the reconnect delay, using frame boundaries rather than a sleep.
    await capture.evaluate(async () => {
      const until = performance.now() + 1200;
      while (performance.now() < until) await new Promise(requestAnimationFrame);
    });
    const retained = await capture.component('ex-terminal-stream-demo', component => ({ ...component.platform.counts }));
    assert.equal(retained.attach, failed.attach, 'An exited command must not start a reconnect loop');
    assert.equal(retained.detach, failed.detach);
    assert.equal(retained.resizes, failed.resizes, 'Exited processes must not receive resizes');
    assert.equal(retained.create, 1);
    assert.equal(await capture.evaluate(() => !!document.querySelector('.connection-notice')), false);
    assert.equal(await capture.component('ex-task-terminal', component => component.attached.surface.context().includes('Command exited with code 7.')), true);
    yield { name: `${theme}-failed-command-retained`, selector: 'ex-task-terminal', metadata: retained };
  }
}
