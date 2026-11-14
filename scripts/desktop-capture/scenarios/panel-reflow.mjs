import assert from 'node:assert/strict';

/** Connected production chat with a bounded longer transcript. Profile before
 * input so panel entry work is included. Timings are diagnostics, not FPS gates. */
export default async function* panelReflow(capture) {
  await capture.evaluate(() => { location.href = '/connected-workspace'; });
  await capture.waitFor(() => document.querySelector('ex-workspace-navigation ex-task-list'));
  await capture.component('ex-machine-workspace', component => component.store.selectSession({ taskId: '11', sessionId: '101' }));
  await capture.waitFor(() => document.querySelector('ex-chat ex-turn'));
  await capture.component('ex-connected-workspace-demo', component => component.fixture.chat.scenario('panel-reflow'));
  await capture.waitFor(() => document.querySelectorAll('ex-chat [data-user-message]').length === 30);
  const draft = 'Keep this draft while the panel moves. '.repeat(6);
  await capture.component('ex-session-chat', (component, draft) => component.store.setDraft(draft), draft);
  const finish = async () => {
    await capture.waitFor(() => document.getAnimations().every(animation => !Number.isFinite(animation.effect?.getComputedTiming().endTime) || animation.playState !== 'running'));
    await capture.settle();
  };
  for (const theme of ['light', 'dark']) {
    await capture.theme(theme);
    for (const width of [1440, 960]) {
      await capture.viewport(width, 960);
      await finish();
      await capture.component('ex-chat-scroll', component => component.scrollToEnd('instant'));
      await capture.evaluate(() => {
        const data = window.panelReflowProbe = { intervals: [], longFrames: [], heightAnimations: 0, active: true };
        const original = window.Element.prototype.animate;
        window.Element.prototype.animate = function (frames, options) {
          if (this.hasAttribute('exAutoHeight') && Array.isArray(frames) && frames.some(frame => 'height' in frame)) data.heightAnimations++;
          return original.call(this, frames, options);
        };
        const observer = new window.PerformanceObserver(list => {
          for (const entry of list.getEntries()) if (data.longFrames.length < 128) data.longFrames.push({ duration: entry.duration, blockingDuration: entry.blockingDuration });
        });
        observer.observe({ type: 'long-animation-frame' });
        let previous, frame;
        const sample = now => {
          if (previous !== undefined && data.intervals.length < 512) data.intervals.push(now - previous);
          previous = now;
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        data.stop = () => { window.cancelAnimationFrame(frame); observer.disconnect(); window.Element.prototype.animate = original; data.active = false; };
      });
      let probe;
      try {
        for (let i = 0; i < 4; i++) {
          await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
          await finish();
        }
        // Reverse while opening: the original width reflow must stay unanimated.
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
        await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
        await finish();
      } finally {
        probe = await capture.evaluate(() => {
          const data = window.panelReflowProbe;
          data.stop();
          return { heightAnimations: data.heightAnimations, longFrames: data.longFrames, intervals: data.intervals, longestFrameInterval: Math.max(0, ...data.intervals) };
        });
      }
      assert.equal(probe.heightAnimations, 0, 'Width reflow must not animate every reply height');
      assert.ok(probe.intervals.length > 0);
      assert.equal(await capture.component('ex-session-chat', component => component.store.draft()), draft);
      assert.equal(await capture.evaluate(() => document.querySelectorAll('ex-chat [data-user-message]').length), 30, 'Longer history survives normal transcript polling');
      assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Toggle side panel');
      assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell .panel').hasAttribute('inert')), true);
      const distance = await capture.evaluate(() => { const viewport = document.querySelector('ex-chat-scroll .viewport'); return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight; });
      assert.ok(distance < 2, 'Width reflow preserves following the end of the conversation');
      yield { name: `${theme}-${width}-panel-reflow`, inspect: ['ex-chat-scroll .viewport', 'ex-composer', 'ex-app-shell .panel'], metadata: probe };
    }
  }
  await capture.reducedMotion(true);
  await capture.viewport(620, 800);
  await capture.click('ex-workspace-task-header [aria-label="Toggle side panel"]');
  await finish();
  assert.equal(await capture.evaluate(() => document.querySelector('ex-app-shell main').hasAttribute('inert')), true);
  yield { name: 'compact-reduced-panel', inspect: ['ex-app-shell main', 'ex-app-shell .panel'] };
  await capture.press('Escape');
  await finish();
  assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Toggle side panel');
  assert.equal(await capture.component('ex-session-chat', component => component.store.draft()), draft);
}
