import assert from 'node:assert/strict';

const item = (id, kind, text, extra = {}) => ({
  id, kind, text, timestamp: '2026-11-22T12:00:00Z', toolId: null,
  toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
});
const call = (id, toolKind) => item(id, 'tool_use', '', { toolId: id, toolKind, toolName: toolKind });
const receipt = (id, error = false) => item(id + '-result', 'tool_result', error ? 'Request failed' : 'Passed', { toolId: id, error });
const pair = (id, kind) => [call(id, kind), receipt(id)];
const items = [
  item('summary-prompt', 'user', 'Review the files and verify the changes.'),
  item('summary-intro', 'assistant', 'I’ll review the files and run the focused checks.'),
  ...pair('summary-read', 'read'), ...pair('summary-command', 'bash'),
  ...pair('summary-edit', 'edit'), ...pair('summary-search', 'grep'),
  call('summary-web', 'web_search'),
  item('summary-progress', 'assistant', 'The changes look good. The web request is still running.'),
  ...pair('summary-following', 'bash'),
  item('summary-reply', 'assistant', 'The focused checks passed.'),
];

const older = '[data-work-step="summary-read"] .group';
const following = '[data-work-step="summary-following"] .group';
const newest = '[data-work-step="summary-new"]';
const preview = 'ex-connected-workspace-demo';

/** Exercise real incremental chat updates and sample the geometry after each paint. */
async function update(capture, page, ready) {
  const frames = await capture.component(preview, async (owner, { page, ready, older, following }) => {
    const timeline = document.querySelector('ex-work-timeline');
    const first = timeline.querySelector(older);
    const later = timeline.querySelector(following);
    const sample = () => {
      const origin = timeline.getBoundingClientRect().top;
      return {
        olderTop: first.getBoundingClientRect().top - origin,
        olderHeight: first.closest('.group-fold').getBoundingClientRect().height,
        olderLabel: first.getAttribute('aria-label'),
        followingTop: later.getBoundingClientRect().top - origin,
        followingLabel: later.getAttribute('aria-label'),
        retained: timeline.querySelector(older) === first && timeline.querySelector(following) === later,
        focused: document.activeElement === later,
      };
    };
    const frames = [sample()];
    owner.fixture.chat.seed(101, page);
    let settled = 0;
    for (let frame = 0; frame < 120; frame++) {
      // Read after ResizeObserver and layout have run for this paint.
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      frames.push(sample());
      const animating = timeline.getAnimations({ subtree: true }).some(a =>
        a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
      settled = document.querySelector(ready) && !animating ? settled + 1 : 0;
      if (settled === 2) return frames;
    }
    throw new Error('Tool update did not settle');
  }, { page, ready, older, following });
  for (const frame of frames) {
    assert.equal(frame.retained, true, 'Keep both summary controls mounted');
    assert.equal(frame.focused, true, 'Keep keyboard focus on the later summary');
    assert.equal(frame.followingLabel, frames[0].followingLabel, 'Update only the matching section');
    assert.ok(Math.abs(frame.olderTop - frames[0].olderTop) <= 1, 'Keep the first summary at the same position');
  }
  return frames;
}

export default async function* (capture) {
  for (const theme of ['light', 'dark']) {
    for (const reduced of [false, true]) {
      await capture.evaluate(() => { location.href = '/connected-workspace'; });
      await capture.waitFor(() => document.querySelector('ex-machine-workspace ex-task-list'));
      await capture.theme(theme);
      await capture.viewport(700, 900);
      await capture.reducedMotion(reduced);
      const state = await capture.component(preview, async owner => {
        const { value } = await owner.fixture.chat.read({ taskId: 11, sessionId: 101, requestId: window.crypto.randomUUID() });
        return { ...value.state, phase: 'running', canInterrupt: true, providerLocked: true };
      });
      await capture.component(preview, (owner, page) => owner.fixture.chat.seed(101, page), { state, items });
      await capture.component('ex-machine-workspace', owner =>
        owner.store.selectSession({ taskId: '11', sessionId: '101' }));
      await capture.waitFor(() =>
        document.querySelector('[data-work-step="summary-web"] section.running'));
      await capture.settle();
      await capture.evaluate(selector => document.querySelector(selector).focus({ preventScroll: true }), following);

      const appended = [...items, call('summary-new', 'bash')];
      const completed = [...appended, receipt('summary-new')];
      const arrive = await update(capture, { state, items: appended }, newest + ' section.running');
      const finish = await update(capture, { state, items: completed }, newest + ' section:not(.running)');
      for (const frame of [...arrive, ...finish]) {
        assert.equal(frame.olderLabel, 'Show activity: 1 read · 1 command · 1 edit · 1 search');
        assert.equal(frame.olderHeight, arrive[0].olderHeight);
        assert.ok(Math.abs(frame.followingTop - arrive[0].followingTop) <= 1, 'Newer work moved an older summary');
      }
      const prefix = theme + (reduced ? '-reduced' : '');
      yield { name: prefix + '-new-tool-settles-below-collapsed-work', inspect: [older, following, newest] };

      const result = await update(capture, { state, items: [...completed, receipt('summary-web', true)] },
        older + '[aria-label*="1 failed"]');
      const first = result[0], last = result.at(-1);
      assert.match(last.olderLabel, /^Show activity: 1 failed .*1 web request$/);
      assert.ok(last.olderHeight >= first.olderHeight + 8, 'The added facts should wrap at this width');
      assert.ok(last.followingTop < first.followingTop, 'The late tool should fold into its summary');
      if (reduced) {
        assert.ok(result.every(frame => frame.followingTop === first.followingTop ||
          frame.followingTop === last.followingTop), 'Reduced motion applies the final height immediately');
      } else {
        assert.ok(result.some(frame => frame.olderHeight > first.olderHeight + 1 &&
          frame.olderHeight < last.olderHeight - 1), 'Grow the summary over several frames');
        assert.ok(result.every(frame => frame.followingTop <= first.followingTop + 1 &&
          frame.followingTop >= last.followingTop - 1), 'The later summary should stay within its travel range');
      }
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'true', following);
      await capture.press('Enter');
      await capture.waitFor(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'false', following);
      yield { name: prefix + '-old-receipt-updates-its-own-summary', inspect: [older, following], metadata: { frames: result } };
    }
  }
}
