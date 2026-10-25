import assert from 'node:assert/strict';

const root = 'ex-sidebar-motion-demo';
const inspect = [
  `${root} [data-testid="sidebar-scroll"]`,
  `${root} [data-task-id="task-4"] > header`,
  `${root} [data-task-id="task-7"] > header`,
  `${root} [data-testid="sidebar-end"]`,
];

/** Real rAF sampling starts before the mutation, without freezing timers or motion. */
async function probeSidebar(options) {
  const host = document.querySelector('ex-sidebar-motion-demo');
  const component = window.ng?.getComponent(host);
  if (!component) throw new Error('Sidebar preview requires Angular development mode');
  const scroller = host.querySelector('[data-testid="sidebar-scroll"]');
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const started = performance.now();
  const selectors = {
    fourth: '[data-task-id="task-4"] > header',
    seventh: '[data-task-id="task-7"] > header',
    neighbor: '[data-task-id="task-5"] > header',
    last: '[data-task-id="task-10"] > header',
    fourthSession: '[data-flip="session:task-4-session-1"] button',
    seventhSession: '[data-flip="session:task-7-session-1"] button',
    footer: '[data-testid="sidebar-end"]',
  };
  const seenAnimations = new Set();
  const originalNodes = new Map([...host.querySelectorAll('[data-task-id]')].map(element => [element.dataset['taskId'], element]));
  const activeAnimations = () => host.getAnimations({ subtree: true }).filter(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime)
      && animation.playState !== 'finished' && animation.playState !== 'idle',
  );
  // Entry staging ends before its height animation begins; only leaving rows
  // represent DOM cleanup boundaries. CSS animations cover entry motion below.
  const pendingRows = () => host.querySelectorAll('ex-fold.leaving').length;
  const snapshot = kind => {
    const animations = activeAnimations();
    for (const animation of animations) seenAnimations.add(animation);
    return {
      time: Math.round((performance.now() - started) * 100) / 100,
      kind,
      fold: options.keepCollapsed ? {
        expanded: host.querySelector('[data-task-id="task-4"] header button').getAttribute('aria-expanded'),
        height: host.querySelector('[data-task-id="task-4"] > ex-fold').getBoundingClientRect().height,
      } : null,
      active: animations.length,
      pending: pendingRows(),
      remaining: Math.max(0, ...animations.map(animation => animation.effect.getComputedTiming().endTime - Number(animation.currentTime))),
      scroll: [scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight],
      boxes: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
        const element = host.querySelector(selector);
        if (!element) return [name, null];
        const box = element.getBoundingClientRect();
        return [name, [box.x, box.y, box.width, box.height].map(value => Math.round(value * 100) / 100)];
      })),
    };
  };
  const distance = (before, after) => Object.fromEntries(Object.keys(selectors).flatMap(name => {
    const previous = before.boxes[name];
    const next = after.boxes[name];
    return previous && next ? [[name, Math.max(...next.map((value, index) => Math.abs(value - previous[index])))]] : [];
  }));
  const invoke = () => {
    if (options.action === 'filter') component.filter.set(options.args[0]);
    else component[options.action](...(options.args ?? []));
    window.ng.applyChanges(component);
  };
  const samples = [snapshot('before')];
  let quietFrames = 0;
  let interruption;
  let interrupted = false;
  let nativeBefore;
  const button = options.interrupt
    ? [...host.querySelectorAll('button')].find(element => element.textContent.trim() === (options.interrupt === 'reset' ? 'Reset ten tasks' : 'Reverse order'))
    : null;
  const onKey = event => {
    if (!event.isTrusted || event.key !== 'Enter' || event.target !== button) return;
    if (event.type === 'keydown') nativeBefore = snapshot('before-native-input');
    else {
      window.ng.applyChanges(component);
      const after = snapshot('after-native-input');
      samples.push(nativeBefore, after);
      interruption = { focused: document.activeElement === button, shift: distance(nativeBefore, after), elapsed: after.time - nativeBefore.time };
      interrupted = true;
      delete host.dataset['motionProbeInput'];
    }
  };
  if (options.interrupt) {
    if (!button) throw new Error('Missing Reverse order control');
    host.addEventListener('keydown', onKey, true);
    host.addEventListener('keyup', onKey, true);
  }
  try {
    invoke();
    samples.push(snapshot('synchronous'));
    // Keep observing until animations AND retained removed rows are gone, then
    // observe three further paints. Merely waiting for animations misses timer
    // cleanup of zero-height rows, which can expose a final spacing snap.
    while (performance.now() - started < 5000 && samples.length < 300) {
      await frame();
      const sample = snapshot('frame');
      samples.push(sample);
      if (options.interrupt && !interrupted && sample.time >= 80 && !host.dataset['motionProbeInput']) {
        button.focus({ preventScroll: true });
        host.dataset['motionProbeInput'] = 'ready';
      }
      if (!sample.active && !sample.pending && (!options.interrupt || interrupted)) quietFrames++;
      else quietFrames = 0;
      if (quietFrames >= 3) break;
    }
    const final = snapshot('settled');
    samples.push(final);
    const frames = samples.filter(sample => sample.kind === 'frame');
    const boundaries = [];
    let longestFrame = 0;
    let maxFrameShift = 0;
    for (let index = 1; index < frames.length; index++) {
      const previous = frames[index - 1];
      const current = frames[index];
      const elapsed = current.time - previous.time;
      const shift = distance(previous, current);
      longestFrame = Math.max(longestFrame, elapsed);
      maxFrameShift = Math.max(maxFrameShift, 0, ...Object.values(shift));
      if ((previous.active && !current.active) || (previous.pending && !current.pending)) {
        // Compare terminal movement with the recent measured speed, accounting
        // for actual frame duration. Large smooth travel is allowed; a new
        // displacement after movement has stopped is not.
        const allowance = Object.fromEntries(Object.keys(shift).map(name => {
          let speed = 0;
          for (let recent = Math.max(1, index - 3); recent < index; recent++) {
            const before = frames[recent - 1];
            const after = frames[recent];
            speed = Math.max(speed, (distance(before, after)[name] ?? 0) / Math.max(1, after.time - before.time));
          }
          return [name, 1.25 + speed * elapsed * 2];
        }));
        boundaries.push({ time: current.time, shift, allowance });
      }
    }
    return {
      samples, boundaries,
      initialShift: distance(samples[0], frames[0]),
      settledShift: distance(frames.at(-1), final),
      maxFrameShift, longestFrame, animationCount: seenAnimations.size,
      unfinished: activeAnimations().length, pending: pendingRows(), interruption,
      visible: [...host.querySelectorAll('[data-task-id]')].filter(element => !element.closest('[inert]')).map(element => element.dataset['taskId']),
      order: component.tasks().map(task => task.id), count: component.tasks().length,
      sessions: component.tasks().find(task => task.id === 'task-4')?.sessions.length ?? 0,
      selected: component.selected(), filter: component.filter(),
      identityStable: [...host.querySelectorAll('[data-task-id]')].every(element => !originalNodes.has(element.dataset['taskId']) || originalNodes.get(element.dataset['taskId']) === element),
    };
  } finally {
    host.removeEventListener('keydown', onKey, true);
    host.removeEventListener('keyup', onKey, true);
    delete host.dataset['motionProbeInput'];
  }
}

async function settleSidebar(capture) {
  await capture.evaluate(async () => {
    const host = document.querySelector('ex-sidebar-motion-demo');
    for (let pass = 0; pass < 12; pass++) {
      const active = host.getAnimations({ subtree: true }).filter(animation =>
        Number.isFinite(animation.effect?.getComputedTiming().endTime)
          && animation.playState !== 'finished' && animation.playState !== 'idle',
      );
      for (const animation of active) animation.finish();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!active.length) return;
    }
    throw new Error('Sidebar did not settle after finishing its owned finite animations');
  });
}

function assertContinuous(name, shifts) {
  for (const [target, pixels] of Object.entries(shifts)) {
    assert.ok(pixels <= 1.25, `${name}: ${target} jumped ${pixels.toFixed(2)}px across an animation boundary`);
  }
}

async function* measure(capture, theme, name, options, expected = {}) {
  const resultPromise = capture.evaluate(probeSidebar, options);
  // Attach a rejection handler immediately while screenshot/input checkpoints
  // are handled; awaiting the same promise below still propagates the error.
  void resultPromise.catch(() => {});
  if (options.interrupt) {
    await capture.waitFor(() => document.querySelector('ex-sidebar-motion-demo')?.dataset['motionProbeInput'] === 'ready');
    // Include the native text event so Chromium activates the focused button,
    // rather than delivering only the key handlers.
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await capture.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  const result = await resultPromise;
  assert.equal(result.unfinished, 0, `${name}: finite animations must clean up`);
  assert.equal(result.pending, 0, `${name}: removed rows must leave the DOM`);
  assert.equal(result.identityStable, true, `${name}: surviving task components retain identity`);
  if (!options.reduced) {
    assertContinuous(`${name} initial`, result.initialShift);
    for (const boundary of result.boundaries) {
      for (const [target, shift] of Object.entries(boundary.shift)) {
        assert.ok(shift <= boundary.allowance[target], `${name}: ${target} snapped ${shift.toFixed(2)}px at ${boundary.time}ms (recent-speed bound ${boundary.allowance[target].toFixed(2)}px)`);
      }
    }
    assertContinuous(`${name} settled`, result.settledShift);
    if (options.moves) assert.ok(result.animationCount > 0, `${name}: expected motion was not observed`);
  } else {
    assert.ok(result.samples.filter(sample => sample.kind === 'frame').every(sample => sample.active === 0), `${name}: reduced motion must settle before the first painted probe frame`);
  }
  if (options.keepCollapsed) {
    for (const sample of result.samples) {
      assert.equal(sample.fold.expanded, 'false', `${name}: collapsed task reopened at ${sample.time}ms`);
      assert.ok(sample.fold.height <= 1, `${name}: hidden sessions grew to ${sample.fold.height}px`);
    }
  }
  if (options.interrupt) {
    assert.ok(result.interruption?.focused, 'Native keyboard input remains focused during reversal');
    // The key event's intermediate DOM can precede post-render FLIP inversion;
    // the surrounding rAF samples carry the painted interruption geometry.
  }
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value, `${name}: ${key}`);
  // The maximum ordinary frame delta is diagnostic: moving 100 rows can have
  // high continuous velocity. Only zero-age/zero-duration boundaries assert a
  // pixel tolerance; endpoint checks use recent speed and actual frame time.
  yield { name: `${theme}-${name}-settled`, inspect, metadata: { probe: result } };
}

/** Run desktop:preview, then desktop:capture this file with --url and --timeout 180. */
export default async function* (capture) {
  await capture.viewport(1320, 1000);
  if (!await capture.evaluate(() => !!document.querySelector('ex-sidebar-motion-demo'))) {
    await capture.click('a[href="/sidebar-motion"]');
  }
  await capture.waitFor(() => document.querySelector('ex-sidebar-motion-demo [data-task-id="task-10"]'));
  await capture.motion.play();
  const originals = Array.from({ length: 10 }, (_, index) => `task-${index + 1}`);
  const reset = async (setup = []) => {
    await capture.component(root, (component, actions) => {
      component.reset();
      for (const [action, ...args] of actions) {
        if (action === 'filter') component.filter.set(args[0]);
        else component[action](...args);
      }
    }, setup);
    await settleSidebar(capture);
    await capture.component(root, component => component.scroll('start'));
  };
  const collapseTarget = async () => {
    if (await capture.evaluate(() => document.querySelector('ex-sidebar-motion-demo [data-task-id="task-4"] header button.toggle').getAttribute('aria-expanded') === 'true')) {
      await capture.click(`${root} [data-task-id="task-4"] header button.toggle`);
    }
    await settleSidebar(capture);
  };
  try {
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      await capture.reducedMotion(false);
      await reset();
      yield { name: `${theme}-ten-tasks-before`, inspect };
      yield* measure(capture, theme, 'add-100', { action: 'add', args: ['start', 100], moves: true }, { count: 110 });
      yield* measure(capture, theme, 'bulk-to-two', { action: 'keepOriginal', args: [[4, 7]], moves: true }, { order: ['task-4', 'task-7'], visible: ['task-4', 'task-7'] });

      for (const position of ['start', 'middle', 'end']) {
        await reset();
        yield* measure(capture, theme, `add-${position}`, { action: 'add', args: [position], moves: true }, { count: 11 });
        await reset();
        yield* measure(capture, theme, `remove-${position}`, { action: 'remove', args: [position], moves: true }, { count: 9 });
      }

      await reset();
      yield* measure(capture, theme, 'only-fourth', { action: 'keepOriginal', args: [[4]], moves: true }, { order: ['task-4'], visible: ['task-4'], selected: 'task-4-session-1' });
      await reset();
      yield* measure(capture, theme, 'fourth-and-seventh', { action: 'keepOriginal', args: [[4, 7]], moves: true }, { order: ['task-4', 'task-7'], visible: ['task-4', 'task-7'] });

      await reset();
      yield* measure(capture, theme, 'remove-all', { action: 'clear', moves: true }, { count: 0, visible: [] });
      yield* measure(capture, theme, 'restore-all', { action: 'reset', moves: true }, { order: originals, visible: originals });
      yield* measure(capture, theme, 'reverse', { action: 'reverse', moves: true }, { order: [...originals].reverse() });
      await reset();
      yield* measure(capture, theme, 'interrupt-reverse', { action: 'reverse', moves: true, interrupt: true }, { order: originals });
      await reset();
      yield* measure(capture, theme, 'interrupt-removal', { action: 'keepOriginal', args: [[4, 7]], moves: true, interrupt: 'reset' }, { order: originals, visible: originals });

      await reset();
      yield* measure(capture, theme, 'needs-you', { action: 'filter', args: ['attention'], moves: true }, { visible: ['task-2', 'task-4', 'task-6', 'task-10'], filter: 'attention' });
      yield* measure(capture, theme, 'clear-filter', { action: 'filter', args: [null], moves: true }, { visible: originals });
      yield* measure(capture, theme, 'move-stage', { action: 'move', args: ['waiting'], moves: true }, { count: 10 });

      await reset();
      await collapseTarget();
      yield* measure(capture, theme, 'collapsed-to-waiting', { action: 'move', args: ['waiting'], moves: true, keepCollapsed: true });
      yield* measure(capture, theme, 'collapsed-to-active', { action: 'move', args: ['active'], moves: true, keepCollapsed: true });

      await reset();
      yield* measure(capture, theme, 'add-session', { action: 'addSession', moves: true }, { sessions: 4 });
      yield* measure(capture, theme, 'finish-session', { action: 'finishSession', moves: true }, { sessions: 4 });
      yield* measure(capture, theme, 'remove-session', { action: 'removeSession', moves: true }, { sessions: 3 });

      for (const position of ['middle', 'end']) {
        await reset();
        await capture.component(root, (component, where) => component.scroll(where), position);
        yield* measure(capture, theme, `${position}-sparse`, { action: 'keepOriginal', args: [[4, 7]], moves: true }, { visible: ['task-4', 'task-7'] });
      }
      await reset();
      await capture.component(root, component => component.scroll('end'));
      yield* measure(capture, theme, 'bottom-add-100', { action: 'add', args: ['end', 100], moves: true }, { count: 110 });

      await capture.reducedMotion(true);
      await reset();
      await collapseTarget();
      yield* measure(capture, theme, 'reduced-collapsed-to-waiting', { action: 'move', args: ['waiting'], reduced: true, keepCollapsed: true });
      yield* measure(capture, theme, 'reduced-collapsed-to-active', { action: 'move', args: ['active'], reduced: true, keepCollapsed: true });
      yield* measure(capture, theme, 'reduced-sparse', { action: 'keepOriginal', args: [[4, 7]], reduced: true }, { visible: ['task-4', 'task-7'] });
      yield* measure(capture, theme, 'reduced-clear', { action: 'clear', reduced: true }, { count: 0 });
      yield* measure(capture, theme, 'reduced-restore', { action: 'reset', reduced: true }, { order: originals });
    }
  } finally {
    await capture.motion.play();
    await capture.reducedMotion(false);
  }
}
