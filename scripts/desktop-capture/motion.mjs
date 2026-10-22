/** Owns animation tracking, playback and sampling for one capture window. */
export class CaptureMotion {
  animations = new Set();

  constructor(page, debuggerConnection) {
    this.page = page;
    this.debugger = debuggerConnection;
    this.message = (_event, method, params) => {
      if (method === 'Animation.animationStarted') this.animations.add(params.animation.id);
      if (method === 'Animation.animationCanceled') this.animations.delete(params.id);
    };
    this.debugger.on('message', this.message);
  }

  initialize() { return this.page.cdp('Animation.enable'); }

  async freeze() {
    await this.page.cdp('Animation.setPlaybackRate', { playbackRate: 0 });
    await this.page.settle();
  }

  async play(rate = 1) {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 10) throw new Error('Playback rate must be >0 and <=10');
    await this.page.cdp('Animation.setPlaybackRate', { playbackRate: rate });
  }

  async seek(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new Error('Animation time must be 0..60000 ms');
    await this.page.settle();
    if (!this.animations.size) throw new Error('No tracked animations. Freeze before triggering a CSS/WAAPI animation.');
    await this.page.cdp('Animation.seekAnimations', { animations: [...this.animations], currentTime: ms });
    await this.page.settle();
  }

  async finish() {
    await this.page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
      }
    });
    await this.page.settle();
  }

  async *frames(name, times, inspect = []) {
    if (!Array.isArray(times) || times.length > 120) throw new Error('Choose up to 120 animation sample times');
    for (const time of times) {
      await this.seek(time);
      yield { name: `${name}-${time}ms`, inspect, metadata: { animationTimeMs: time } };
    }
  }

  async measure(selectors, durationMs = 500) {
    if (!Array.isArray(selectors) || selectors.length > 30 || selectors.some(s => typeof s !== 'string')
      || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 3000) throw new Error('Measure up to 30 selectors for 1..3000 ms');
    return this.page.evaluate(async (selectors, durationMs) => {
      const samples = [];
      const started = performance.now();
      let maxShift = 0, maxFrameMs = 0;
      while (performance.now() - started < durationMs && samples.length < 360) {
        const time = await new Promise(resolve => requestAnimationFrame(resolve));
        const boxes = Object.fromEntries(selectors.map(selector => {
          const node = document.querySelector(selector);
          if (!node) throw new Error('Missing probe target: ' + selector);
          const rect = node.getBoundingClientRect();
          return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
        }));
        const previous = samples.at(-1);
        if (previous) {
          maxFrameMs = Math.max(maxFrameMs, time - previous.time);
          for (const selector of selectors) maxShift = Math.max(maxShift, Math.hypot(boxes[selector].x - previous.boxes[selector].x, boxes[selector].y - previous.boxes[selector].y));
        }
        samples.push({ time, boxes });
      }
      return { samples, maxShift, maxFrameMs };
    }, selectors, durationMs);
  }

  dispose() {
    this.debugger.removeListener('message', this.message);
    this.animations.clear();
  }
}
