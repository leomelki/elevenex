import { setTimeout as delay } from 'node:timers/promises';
import { CaptureConnection } from './connection.mjs';
import { CaptureInput } from './input.mjs';
import { CaptureMotion } from './motion.mjs';
import { inspectPage } from './inspection.mjs';

/** Scenario API and renderer state boundary. Owns and disposes its capabilities. */
export class Capture {
  constructor(window, nativeTheme, options, report) {
    this.window = window;
    this.options = options;
    this.nativeTheme = nativeTheme;
    this.connection = new CaptureConnection(window.webContents.debugger, report);
    this.input = new CaptureInput(this);
    this.motion = new CaptureMotion(this, window.webContents.debugger);
  }

  async initialize() {
    await this.connection.initialize();
    await this.motion.initialize();
    await this.viewport(this.options.width, this.options.height);
    await this.theme(this.options.theme);
    await this.reducedMotion(!!this.options.reducedMotion);
  }

  cdp(method, params = {}) { return this.connection.send(method, params); }

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

  // Preserve the compact scenario API; capability modules own the behavior.
  rect(selector) { return this.input.rect(selector); }
  hover(selector) { return this.input.hover(selector); }
  click(selector) { return this.input.click(selector); }
  press(key, modifiers = 0) { return this.input.press(key, modifiers); }
  fill(selector, value) { return this.input.fill(selector, value); }
  inspect(selectors = []) { return this.evaluate(inspectPage, selectors); }
  frames(name, times, inspect = []) { return this.motion.frames(name, times, inspect); }
  measureMotion(selectors, durationMs = 500) { return this.motion.measure(selectors, durationMs); }

  async accessibility() {
    const { nodes } = await this.cdp('Accessibility.getFullAXTree');
    return nodes.filter(node => !node.ignored).slice(0, 2000).map(node => ({ id: node.nodeId, role: node.role?.value, name: node.name?.value, properties: node.properties, children: node.childIds }));
  }

  dispose() {
    this.motion.dispose();
    this.connection.dispose();
  }
}
