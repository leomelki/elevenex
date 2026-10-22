import { setTimeout as delay } from 'node:timers/promises';

/** Main-process automation only. Nothing here is imported by the renderer or preload. */
export class Capture {
  constructor(window, nativeTheme, options, report) {
    this.window = window;
    this.options = options;
    this.report = report;
    this.nativeTheme = nativeTheme;
    this.animations = new Map();
    this.debugger = window.webContents.debugger;
    this.debugger.attach('1.3');
    this.message = (_event, method, params) => {
      if (method === 'Animation.animationStarted') this.animations.set(params.animation.id, params.animation);
      if (method === 'Animation.animationCanceled') this.animations.delete(params.id);
      if (method === 'Runtime.exceptionThrown') this.diagnostic('error', params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
      if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(params.type)) {
        this.diagnostic(params.type === 'error' ? 'error' : 'warning', params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '));
      }
      if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) this.diagnostic(params.entry.level, params.entry.text);
      if (method === 'Network.responseReceived' && params.response.status >= 400) this.diagnostic('error', `HTTP ${params.response.status}: ${params.response.url}`);
      if (method === 'Network.loadingFailed' && !params.canceled) this.diagnostic('error', `${params.errorText} (${params.type})`);
    };
    this.debugger.on('message', this.message);
    this.motion = {
      freeze: async () => { await this.cdp('Animation.setPlaybackRate', { playbackRate: 0 }); await this.settle(); },
      play: async (rate = 1) => {
        if (!Number.isFinite(rate) || rate <= 0 || rate > 10) throw new Error('Playback rate must be >0 and <=10');
        await this.cdp('Animation.setPlaybackRate', { playbackRate: rate });
      },
      seek: async ms => {
        if (!Number.isFinite(ms) || ms < 0 || ms > 60000) throw new Error('Animation time must be 0..60000 ms');
        await this.settle();
        const animations = [...this.animations.keys()];
        if (!animations.length) throw new Error('No tracked animations. Freeze before triggering a CSS/WAAPI animation.');
        await this.cdp('Animation.seekAnimations', { animations, currentTime: ms });
        await this.settle();
      },
      finish: async () => {
        await this.evaluate(() => {
          for (const animation of document.getAnimations()) {
            if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
          }
        });
        await this.settle();
      },
    };
  }

  diagnostic(level, message) {
    const list = level === 'error' ? this.report.errors : this.report.warnings;
    if (list.length < 200) list.push(String(message).slice(0, 8000));
    else this.report.droppedDiagnostics++;
  }

  async initialize() {
    for (const domain of ['Runtime', 'Log', 'Network', 'Animation']) await this.cdp(`${domain}.enable`);
    await this.viewport(this.options.width, this.options.height);
    await this.theme(this.options.theme);
    await this.reducedMotion(!!this.options.reducedMotion);
  }

  cdp(method, params = {}) { return this.debugger.sendCommand(method, params); }

  async evaluate(fn, ...args) {
    if (typeof fn !== 'function') throw new Error('evaluate requires a function');
    const serialized = JSON.stringify(args);
    if (serialized.length > 1024 * 1024) throw new Error('evaluate arguments exceed 1 MiB');
    // A local scenario is trusted code. Execute in the page, never expose a main-process
    // evaluator or debugging method through window.elevenex.
    return this.execute(`(${fn.toString()})(...${serialized})`);
  }

  async execute(expression) {
    // Returning an error envelope preserves useful renderer stacks and allows a
    // scenario to assert rejection without generating an uncaught page exception.
    const result = await this.window.webContents.executeJavaScript(`(async () => {
      try { return { ok: true, value: await (${expression}) }; }
      catch (error) { return { ok: false, message: String(error?.message ?? error), stack: error?.stack }; }
    })()`);
    if (!result.ok) {
      const error = new Error(result.message);
      if (result.stack) error.stack = result.stack;
      throw error;
    }
    return result.value;
  }

  async waitFor(predicate, ...args) {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      if (await this.evaluate(predicate, ...args)) return;
      await delay(20);
    }
    throw new Error(`UI condition timed out: ${predicate.toString().slice(0, 240)}`);
  }

  async settle() {
    await this.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].filter(image => image.currentSrc).map(image => image.decode()));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }

  async component(selector, change, data = null) {
    if (typeof change !== 'function') throw new Error('component requires a function');
    const serialized = JSON.stringify({ selector, data });
    if (serialized.length > 1024 * 1024) throw new Error('component arguments exceed 1 MiB');
    const result = await this.execute(`(async () => {
      const {selector, data} = ${serialized};
      const elements = document.querySelectorAll(selector);
      if (elements.length !== 1) throw new Error('Expected one Angular component at ' + selector + ', got ' + elements.length);
      if (!window.ng?.getComponent) throw new Error('Angular debug APIs unavailable. Use development mode for component state; production supports DOM/input only.');
      const component = window.ng.getComponent(elements[0]);
      if (!component) throw new Error('No Angular component on ' + selector);
      const result = await (${change.toString()})(component, data);
      window.ng.applyChanges(component);
      return result;
    })()`);
    await this.settle();
    return result;
  }

  async rect(selector) {
    return this.evaluate(selector => {
      const elements = document.querySelectorAll(selector);
      if (elements.length !== 1) throw new Error(`Expected one element at ${selector}, got ${elements.length}`);
      const element = elements[0];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') throw new Error(`Element is hidden: ${selector}`);
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, disabled: element.matches(':disabled') };
    }, selector);
  }

  async hover(selector) {
    const rect = await this.rect(selector);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.settle();
  }

  async click(selector) {
    const rect = await this.rect(selector);
    if (rect.disabled) throw new Error(`Cannot click disabled control: ${selector}`);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = await this.evaluate((selector, x, y) => document.querySelector(selector).contains(document.elementFromPoint(x, y)), selector, x, y);
    if (!hit) throw new Error(`Click target is covered or outside the viewport: ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) await this.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await this.settle();
  }

  async press(key, modifiers = 0) {
    // For complex keyboard/touch/drag input use cdp directly with explicit fields.
    for (const type of ['keyDown', 'keyUp']) await this.cdp('Input.dispatchKeyEvent', { type, key, modifiers,
      ...(key.length === 1 ? { text: type === 'keyDown' ? key : '' } : {}),
      ...({ Tab: { windowsVirtualKeyCode: 9 }, Enter: { windowsVirtualKeyCode: 13 }, Escape: { windowsVirtualKeyCode: 27 } }[key] ?? {}),
    });
    await this.settle();
  }

  async fill(selector, value) {
    await this.click(selector);
    await this.evaluate(selector => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) || input.readOnly) throw new Error('fill needs an editable input or textarea');
      input.select();
    }, selector);
    await this.cdp('Input.insertText', { text: String(value) });
    await this.settle();
  }

  async viewport(width, height) {
    if (![width, height].every(value => Number.isInteger(value) && value >= 240 && value <= 4096)) throw new Error('Viewport dimensions must be integers in 240..4096');
    await this.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    this.options.width = width;
    this.options.height = height;
  }

  async theme(theme) {
    if (!['light', 'dark'].includes(theme)) throw new Error('Theme must be light or dark');
    this.nativeTheme.themeSource = theme;
    this.options.theme = theme;
    await this.media();
  }

  async reducedMotion(reduce) {
    if (typeof reduce !== 'boolean') throw new Error('reducedMotion requires a boolean');
    this.options.reducedMotion = reduce;
    await this.media();
  }

  media() {
    return this.cdp('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: this.options.theme },
      { name: 'prefers-reduced-motion', value: this.options.reducedMotion ? 'reduce' : 'no-preference' },
    ] });
  }

  async inspect(selectors = []) {
    return this.evaluate(selectors => {
      const element = node => {
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { tag: node.tagName.toLowerCase(), text: node.textContent?.trim().slice(0, 2000),
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
          style: Object.fromEntries(['display', 'visibility', 'opacity', 'transform', 'color', 'background-color', 'overflow', 'transition-duration', 'animation-name'].map(key => [key, style.getPropertyValue(key)])),
          attributes: Object.fromEntries([...node.attributes].filter(a => /^(aria-|role$|disabled$|tabindex$|data-)/.test(a.name)).map(a => [a.name, a.value])),
        };
      };
      return { url: location.href, theme: document.documentElement.dataset['theme'] ?? null,
        media: { dark: matchMedia('(prefers-color-scheme: dark)').matches, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches },
        viewport: { width: innerWidth, height: innerHeight },
        focus: document.activeElement ? element(document.activeElement) : null,
        elements: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].slice(0, 100).map(element)])),
        animations: document.getAnimations().slice(0, 100).map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime,
          timing: animation.effect?.getComputedTiming() })),
      };
    }, selectors);
  }

  async accessibility() {
    const { nodes } = await this.cdp('Accessibility.getFullAXTree');
    return nodes.filter(node => !node.ignored).slice(0, 2000).map(node => ({ id: node.nodeId, role: node.role?.value, name: node.name?.value, properties: node.properties, children: node.childIds }));
  }

  async measureMotion(selectors, durationMs = 500) {
    if (!Array.isArray(selectors) || selectors.length > 30 || selectors.some(s => typeof s !== 'string')
      || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 3000) throw new Error('Measure up to 30 selectors for 1..3000 ms');
    return this.evaluate(async (selectors, durationMs) => {
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

  async *frames(name, times, inspect = []) {
    if (!Array.isArray(times) || times.length > 120) throw new Error('Choose up to 120 animation sample times');
    for (const time of times) {
      await this.motion.seek(time);
      yield { name: `${name}-${time}ms`, inspect, metadata: { animationTimeMs: time } };
    }
  }

  dispose() {
    this.debugger.removeListener('message', this.message);
    if (this.debugger.isAttached()) this.debugger.detach();
  }
}
