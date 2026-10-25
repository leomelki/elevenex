import assert from 'node:assert/strict';

const root = 'ex-git-motion-demo';
const inspect = [
  `${root} [data-git-motion="title"]`,
  `${root} [data-git-motion="branch"]`,
  `${root} [data-git-motion="link"]`,
  `${root} ex-git-bar`,
  `${root} .primary`,
  `${root} .action-slot`,
  `${root} .stat-slot`,
];

/** Start sampling before the public state mutation, and let real frames and cleanup run. */
async function probeGit(options) {
  const host = document.querySelector('ex-git-motion-demo');
  const component = window.ng?.getComponent(host);
  if (!component) throw new Error('Git preview requires Angular development mode');
  const bar = host.querySelector('ex-git-bar');
  const primary = bar.querySelector('.primary');
  const more = bar.querySelector('.more');
  const started = performance.now();
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const active = () => bar.getAnimations({ subtree: true }).filter(animation =>
    Number.isFinite(animation.effect?.getComputedTiming().endTime)
      && animation.playState !== 'finished' && animation.playState !== 'idle',
  );
  const seenAnimations = new Set();
  const firstOrigins = {};
  // Validate the actual animation curve as well as adjacent paints. A slow host
  // can miss the accelerating middle of a transition for hundreds of ms.
  const ease = (value, progress) => {
    if (!value || value === 'linear') return progress;
    const match = value.match(/^cubic-bezier\(([^)]+)\)$/);
    if (!match) throw new Error(`Unexpected width easing: ${value}`);
    const [x1, y1, x2, y2] = match[1].split(',').map(Number);
    const bezier = (time, first, second) => 3 * (1 - time) ** 2 * time * first + 3 * (1 - time) * time ** 2 * second + time ** 3;
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 24; iteration++) {
      const time = (low + high) / 2;
      if (bezier(time, x1, x2) < progress) low = time;
      else high = time;
    }
    return bezier((low + high) / 2, y1, y2);
  };
  const widthCheck = (element, key) => {
    const actual = element.getBoundingClientRect().width;
    const target = parseFloat(element.style.width);
    const animation = element.getAnimations().find(item => item.effect?.getKeyframes().some(keyframe => keyframe.width) && !['finished', 'idle'].includes(item.playState));
    let expected = target;
    let endpointError = 0;
    if (animation) {
      const frames = animation.effect.getKeyframes();
      const progress = animation.effect.getComputedTiming().progress ?? 0;
      firstOrigins[key] ??= parseFloat(frames[0].width);
      endpointError = Math.abs(parseFloat(frames.at(-1).width) - target);
      const end = frames.findIndex((keyframe, index) => index > 0 && keyframe.computedOffset >= progress);
      const left = frames[Math.max(0, end - 1)];
      const right = frames[end < 0 ? frames.length - 1 : end];
      const local = (progress - left.computedOffset) / (right.computedOffset - left.computedOffset || 1);
      expected = parseFloat(left.width) + (parseFloat(right.width) - parseFloat(left.width)) * ease(left.easing, local);
    }
    return [Math.round(actual * 1000) / 1000, Math.round(expected * 1000) / 1000, Math.round(endpointError * 1000) / 1000];
  };
  const snapshot = kind => {
    const animations = active();
    for (const animation of animations) seenAnimations.add(animation);
    const box = element => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100);
    };
    const inks = [...primary.querySelectorAll('.action-ink')].map(element => {
      let opacity = 1;
      for (let parent = element; parent && parent !== bar; parent = parent.parentElement) {
        opacity *= Number(getComputedStyle(parent).opacity);
      }
      return { text: element.textContent.trim().replace(/\s+/g, ' '), opacity: Math.round(opacity * 1000) / 1000, offset: element.getBoundingClientRect().left - primary.getBoundingClientRect().left, countHeight: element.querySelector(".rolling")?.getBoundingClientRect().height ?? null };
    });
    const widthAnimation = animations.find(animation => animation.effect?.target === primary && animation.effect.getKeyframes().some(keyframe => keyframe.width));
    const widthFrames = widthAnimation?.effect.getKeyframes();
    return {
      time: Math.round((performance.now() - started) * 100) / 100,
      kind,
      active: animations.length,
      pending: bar.querySelectorAll('.leaving').length,
      sameButton: primary === bar.querySelector('.primary') && more === bar.querySelector('.more'),
      boxes: {
        bar: box(bar), primary: box(primary),
        action: box(bar.querySelector('.action-slot')), stat: box(bar.querySelector('.stat-slot')),
        title: box(host.querySelector('[data-git-motion="title"]')),
        branch: box(host.querySelector('[data-git-motion="branch"]')),
        link: box(host.querySelector('[data-git-motion="link"]')),
      },
      right: Math.round(bar.getBoundingClientRect().right * 100) / 100,
      inks,
      primaryTarget: parseFloat(primary.style.width),
      primaryMotion: widthAnimation ? {
        age: Number(widthAnimation.currentTime),
        duration: widthAnimation.effect.getTiming().duration,
        progress: widthAnimation.effect.getComputedTiming().progress,
        from: widthFrames[0].width,
        to: widthFrames.at(-1).width,
      } : null,
      widths: {
        primary: widthCheck(primary, 'primary'),
        action: widthCheck(bar.querySelector('.action-slot'), 'action'),
        stat: widthCheck(bar.querySelector('.stat-slot'), 'stat'),
      },
    };
  };
  const delta = (previous, next) => ({
    primaryWidth: Math.abs(next.boxes.primary[2] - previous.boxes.primary[2]),
    actionWidth: Math.abs(next.boxes.action[2] - previous.boxes.action[2]),
    statWidth: Math.abs(next.boxes.stat[2] - previous.boxes.stat[2]),
    barLeft: Math.abs(next.boxes.bar[0] - previous.boxes.bar[0]),
  });
  const samples = [snapshot('before')];
  const steps = options.indices ?? [options.index];
  const transitions = [];
  const change = index => {
    transitions.push({ index, time: performance.now() - started });
    component.select(index);
    window.ng.applyChanges(component);
  };
  change(steps[0]);
  samples.push(snapshot('synchronous'));
  let nextStep = 1;
  let quiet = 0;
  while (performance.now() - started < 5000 && samples.length < 300) {
    await frame();
    const sample = snapshot('frame');
    samples.push(sample);
    if (nextStep < steps.length && sample.time >= nextStep * 80) {
      samples.push(snapshot('before-interruption'));
      change(steps[nextStep++]);
      samples.push(snapshot('after-interruption'));
      quiet = 0;
      continue;
    }
    if (!sample.active && !sample.pending && nextStep === steps.length) quiet++;
    else quiet = 0;
    if (quiet >= 3) break;
  }
  const final = snapshot('settled');
  samples.push(final);
  const frames = samples.filter(sample => sample.kind === 'frame');
  const boundaries = [];
  let longestFrame = 0;
  const maximum = { primaryWidth: 0, actionWidth: 0, statWidth: 0, barLeft: 0 };
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1];
    const current = frames[index];
    const elapsed = current.time - previous.time;
    const shift = delta(previous, current);
    longestFrame = Math.max(longestFrame, elapsed);
    for (const key of Object.keys(maximum)) maximum[key] = Math.max(maximum[key], shift[key]);
    if ((previous.active && !current.active) || (previous.pending && !current.pending)) {
      const allowance = {};
      for (const key of Object.keys(shift)) {
        let speed = 0;
        for (let recent = Math.max(1, index - 3); recent < index; recent++) {
          speed = Math.max(speed, delta(frames[recent - 1], frames[recent])[key] / Math.max(1, frames[recent].time - frames[recent - 1].time));
        }
        allowance[key] = 1.25 + speed * elapsed * 2;
      }
      boundaries.push({ time: current.time, elapsed, shift, allowance });
    }
  }
  const before = samples[0];
  const outgoing = before.inks.find(ink => ink.opacity > .9);
  const synchronous = samples[1].inks.find(ink => ink.text === outgoing?.text);
  return {
    inkJump: outgoing && synchronous ? Math.abs(outgoing.offset - synchronous.offset) : 0,
    countCollapsed: outgoing?.countHeight > 0 && synchronous?.countHeight === 0,
    samples, transitions, boundaries, maximum, longestFrame,
    initialShift: delta(before, frames[0]), settledShift: delta(frames.at(-1), final),
    initiallyHidden: before.boxes.action[2] < .5,
    firstPaintElapsed: frames[0].time - before.time,
    firstOrigins: Object.fromEntries(Object.entries(firstOrigins).map(([key, value]) => [key, Math.abs(value - before.boxes[key][2])])),
    widthError: Math.max(...frames.flatMap(sample => Object.values(sample.widths).map(([actual, expected]) => Math.abs(actual - expected)))),
    endpointError: Math.max(...frames.flatMap(sample => Object.values(sample.widths).map(([, , error]) => error))),
    rightDrift: Math.max(...samples.map(sample => Math.abs(sample.right - before.right))),
    fixedDrift: Math.max(...samples.flatMap(sample => ['title', 'branch', 'link'].flatMap(key => sample.boxes[key].map((value, index) => Math.abs(value - before.boxes[key][index]))))),
    overlap: Math.max(...frames.map(sample => sample.inks.filter(ink => ink.opacity > .12).length)),
    sameButton: samples.every(sample => sample.sameButton),
    animationCount: seenAnimations.size, unfinished: active().length, pending: final.pending,
    selected: component.selected(), label: primary.getAttribute('aria-label'),
    hidden: bar.querySelector('.action-slot').hasAttribute('inert'),
  };
}

async function settleGit(capture) {
  await capture.evaluate(async () => {
    const bar = document.querySelector('ex-git-motion-demo ex-git-bar');
    let quiet = 0;
    for (let frames = 0; frames < 180; frames++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const active = bar.getAnimations({ subtree: true }).some(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime) && !['finished', 'idle'].includes(animation.playState));
      if (!active && !bar.querySelector('.leaving')) quiet++;
      else quiet = 0;
      if (quiet >= 3) return;
    }
    throw new Error('GitBar did not settle');
  });
}

async function* measure(capture, name, options) {
  const result = await capture.evaluate(probeGit, options);
  // Preserve the complete measured evidence even when an assertion below fails.
  yield { name, inspect, metadata: { probe: result } };
  assert.equal(result.unfinished, 0, `${name}: finite motion must finish`);
  assert.equal(result.pending, 0, `${name}: outgoing ink must be removed`);
  assert.equal(result.countCollapsed, false, `${name}: outgoing count collapsed before fading`);
  assert.ok(result.inkJump <= .5, `${name}: outgoing label jumped ${result.inkJump}px before fading`);
  assert.equal(result.sameButton, true, `${name}: native action and menu buttons must persist`);
  assert.ok(result.fixedDrift <= .5, `${name}: title, branch or link moved ${result.fixedDrift}px`);
  assert.ok(result.rightDrift <= .5, `${name}: right edge moved ${result.rightDrift}px`);
  assert.ok(result.overlap <= 1, `${name}: outgoing and incoming labels overlapped substantially`);
  assert.ok(result.widthError <= .5, `${name}: painted width diverged ${result.widthError}px from its own animation curve`);
  assert.ok(result.endpointError <= .5, `${name}: animation ended ${result.endpointError}px away from settled width`);
  assert.equal(result.selected, options.indices?.at(-1) ?? options.index);
  if (options.reduced) {
    assert.ok(result.samples.filter(sample => sample.kind === 'frame').every(sample => sample.active === 0), `${name}: reduced motion must settle before the first painted probe frame`);
  } else {
    for (const [key, shift] of Object.entries(result.firstOrigins)) {
      if (key === 'primary' && result.initiallyHidden) continue;
      assert.ok(shift <= 1.25, `${name}: ${key} animation began ${shift}px from its previous width`);
    }
    for (const [key, shift] of Object.entries(result.initialShift)) {
      // The spec deliberately sizes hidden contents immediately; the visible
      // outer slot still starts at zero and opens without a painted jump.
      if (key === 'primaryWidth' && result.initiallyHidden) continue;
      if (result.firstPaintElapsed > 40) continue;
      assert.ok(shift <= 1.25, `${name}: ${key} jumped ${shift.toFixed(2)}px before its first painted frame`);
    }
    for (const boundary of result.boundaries) {
      // Interpolation and endpoint checks above remain strict across missed
      // frames; recent speed is only meaningful with an ordinary frame gap.
      if (boundary.elapsed > 40) continue;
      for (const [key, shift] of Object.entries(boundary.shift)) {
        assert.ok(shift <= boundary.allowance[key], `${name}: ${key} snapped ${shift.toFixed(2)}px at ${boundary.time}ms (recent-speed bound ${boundary.allowance[key].toFixed(2)}px)`);
      }
    }
    for (const [key, shift] of Object.entries(result.settledShift)) assert.ok(shift <= .5, `${name}: ${key} snapped after settling`);
  }
}

/** Run against desktop:preview with --url and --timeout 180; never freezes JS cleanup. */
export default async function* (capture) {
  await capture.viewport(1320, 1000);
  if (!await capture.evaluate(() => !!document.querySelector('ex-git-motion-demo'))) await capture.click('a[href="/git-motion"]');
  await capture.waitFor(() => document.querySelector('ex-git-motion-demo .primary'));
  await capture.motion.play();
  const ids = ['edits', 'committing', 'push-one', 'pushing', 'current', 'new-edits', 'committing-again', 'push-three', 'many-edits'];
  try {
    for (const theme of ['light', 'dark']) {
      await capture.theme(theme);
      for (const compact of [false, true]) {
        await capture.reducedMotion(false);
        await capture.component(root, (component, value) => { component.compact.set(value); component.select(0); }, compact);
        await settleGit(capture);
        let direct = 0;
        const prefix = `${theme}-${compact ? 'compact' : 'full'}`;
        yield { name: `${prefix}-initial`, inspect };
        for (let index = 1; index < ids.length; index++) yield* measure(capture, `${prefix}-${ids[index]}`, { index });
        // Direct Push → Commit changes used to let the wider incoming grid
        // track shove and clip the outgoing icon, label and count in one frame.
        for (const index of [7, 0, 7, 8, 0, 8, 0])
          yield* measure(capture, `${prefix}-direct-${index}-${direct++}`, { index });
        yield* measure(capture, `${prefix}-interruptions`, { indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 4, 0] });
        await capture.reducedMotion(true);
        for (const index of [1, 2, 4, 5, 8]) yield* measure(capture, `${prefix}-reduced-${ids[index]}`, { index, reduced: true });
      }
    }
  } finally {
    await capture.component(root, component => component.stop());
    await capture.reducedMotion(false);
    await capture.motion.play();
  }
}
