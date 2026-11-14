import type { BrowserCodeImage } from '@elevenex/shared';
import { CDP_METHODS, validateCdp } from './cdp-policy.js';
import { delay, integer, object, type BrowserAgentHost } from './host.js';
import { PlaywrightWorkerClient } from './playwright-worker-client.js';
import type { PlaywrightCallback } from './playwright-channel.js';
import { AgentTarget } from './target.js';

export class BrowserAgentBroker {
  private readonly targets = new Map<string, AgentTarget>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly captures = new WeakMap<BrowserCodeImage[], number>();
  private readonly acquiring = new Map<string, Promise<unknown>>();
  private readonly playwright?: PlaywrightWorkerClient;
  constructor(
    private readonly host: BrowserAgentHost,
    private readonly sessionId: number,
  ) {
    if (host.playwright)
      this.playwright = new PlaywrightWorkerClient(host, sessionId);
  }
  bind(
    callback: PlaywrightCallback,
    notify: (updates: unknown[]) => void,
    failed?: (message: string) => void,
  ): void {
    this.playwright?.bind(callback, notify, failed);
  }
  prepare(signal: AbortSignal): Promise<unknown[]> {
    return this.playwright?.prepare(signal) ?? Promise.resolve([]);
  }
  get retained(): boolean {
    return this.playwright?.retained ?? false;
  }
  drainRequests(): import('@elevenex/shared').BrowserHumanRequest[] {
    return this.playwright?.drainRequests() ?? [];
  }
  private remember(
    id: string | null,
    url: string | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!id) return this.acquire(id, url, signal);
    const pending = this.acquiring.get(id);
    if (pending) return pending;
    const operation = this.acquire(id, url, signal).finally(() => {
      if (this.acquiring.get(id) === operation) this.acquiring.delete(id);
    });
    this.acquiring.set(id, operation);
    return operation;
  }
  private async acquire(
    id: string | null,
    url: string | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (id) {
      const cached = [...this.targets.values()].find(
        (item) => item.target.id === id,
      );
      if (cached) {
        try {
          cached.target.assert();
          return { handle: cached.handle, id };
        } catch {
          // Explicit reacquisition can use a later human handoff; old code
          // handles remain revoked and never acquire authority implicitly.
          cached.dispose();
          this.targets.delete(cached.handle);
        }
      }
    }
    if (this.targets.size >= 12)
      throw new Error(
        'At most twelve tab handles; reset the sandbox to release stale handles',
      );
    if (id) await this.host.acquire?.(this.sessionId, id, signal);
    const raw = id
      ? await this.host.get(this.sessionId, id)
      : await this.host.open(this.sessionId, url!, signal);
    if (signal.aborted) {
      await raw.dispose?.();
      signal.throwIfAborted();
    }
    const target = new AgentTarget(raw);
    target.signal = signal;
    try {
      await target.start();
      signal.throwIfAborted();
      this.targets.set(target.handle, target);
      if (url) {
        await target.target.goto(url, signal);
        signal.throwIfAborted();
        target.target.assert();
      }
      return { handle: target.handle, id: raw.id };
    } catch (error) {
      this.targets.delete(target.handle);
      target.dispose();
      throw error;
    }
  }
  invoke(
    method: string,
    args: unknown[],
    signal: AbortSignal,
    images: BrowserCodeImage[],
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (method === 'pw') {
      if (!this.playwright)
        return Promise.reject(
          new Error('This browser host needs a Playwright update'),
        );
      return this.playwright.invoke(args[0], signal, images);
    }
    const handle = args[0];
    if (['new', 'get', 'list', 'wait'].includes(method))
      return this.execute(method, args, signal, images);
    if (typeof handle !== 'string')
      return Promise.reject(new Error('Invalid tab handle'));
    const lane = this.targets.get(handle)?.target.id ?? handle;
    // Ordering is per tab. Parallel work on independent tabs remains concurrent.
    const pending = (this.lanes.get(lane) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted();
        return this.execute(method, args, signal, images);
      });
    this.lanes.set(lane, pending);
    void pending
      .finally(() => {
        if (this.lanes.get(lane) === pending) this.lanes.delete(lane);
      })
      .catch(() => undefined);
    return pending;
  }
  private async execute(
    method: string,
    args: unknown[],
    signal: AbortSignal,
    images: BrowserCodeImage[],
  ): Promise<unknown> {
    if (method === 'list') return this.host.list(this.sessionId);
    if (method === 'wait') {
      await delay(integer(args[0], 0, 0, 10000), signal);
      return null;
    }
    if (method === 'new') {
      if (typeof args[0] !== 'string')
        throw new Error('tabs.new requires an HTTP(S) URL');
      return this.remember(null, args[0], signal);
    }
    if (method === 'get') {
      if (typeof args[0] !== 'string')
        throw new Error('tabs.get requires a tab ID from tabs.list');
      return this.remember(args[0], null, signal);
    }
    const target = this.targets.get(String(args[0]));
    if (!target)
      throw new Error(
        'Tab handle expired; get the tab again or reset the sandbox',
      );
    target.signal = signal;
    target.target.assert();
    const send = async (name: string, params: Record<string, unknown>) => {
      signal.throwIfAborted();
      const result = await target.send(name, params);
      signal.throwIfAborted();
      return result;
    };
    if (method === 'goto') {
      if (typeof args[1] !== 'string')
        throw new Error('goto requires an HTTP(S) URL');
      await target.target.goto(args[1], signal);
      target.target.assert();
      return null;
    }
    if (method === 'evaluate')
      return target.evaluate(args[1], args[2], args[3] === true);
    if (method === 'snapshot') return target.snapshot(object(args[1]));
    if (method === 'events') return target.events(object(args[1]));
    if (method === 'screenshot') {
      const attempts = this.captures.get(images) ?? 0;
      if (attempts >= 4) throw new Error('At most four screenshots per call');
      this.captures.set(images, attempts + 1);
      const capture = await target.screenshot(object(args[1]));
      signal.throwIfAborted();
      images.push(capture.image);
      return {
        image: images.length,
        width: capture.image.width,
        height: capture.image.height,
        clip: capture.clip,
        scale: capture.scale,
        viewport: capture.viewport,
        coordinates:
          'Input uses viewport CSS pixels. For image coordinates (ix,iy), use x=clip.x+ix/scale-viewport.pageX; y=clip.y+iy/scale-viewport.pageY.',
      };
    }
    if (method === 'cdp') {
      const params = object(args[2]),
        name = validateCdp(args[1], params);
      if (!CDP_METHODS.has(name)) throw new Error('CDP method denied');
      return send(name, params);
    }
    if (method === 'close') {
      await target.target.close();
      target.dispose();
      this.targets.delete(target.handle);
      return null;
    }
    if (method === 'type' || method === 'fill') {
      const text = method === 'type' ? args[1] : args[2];
      if (typeof text !== 'string' || text.length > 65536)
        throw new Error('Text limit is 65536 characters');
      if (method === 'fill') await target.point(args[1], true);
      await send('Input.insertText', { text });
      return null;
    }
    if (method === 'click') {
      const point =
        typeof args[1] === 'string'
          ? await target.point(args[1])
          : { x: args[1], y: args[2] };
      this.coordinates(point.x, point.y);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        clickCount: 1,
      });
      return null;
    }
    if (method === 'scroll') {
      for (const value of args.slice(1))
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          Math.abs(value) > 10000
        )
          throw new Error(
            'Scroll values must be finite and at most 10000 CSS pixels',
          );
      const [deltaX, deltaY, x, y] = args.slice(1);
      this.coordinates(x, y);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX,
        deltaY,
      });
      return null;
    }
    if (method === 'press') {
      if (typeof args[1] !== 'string')
        throw new Error('press requires a key name');
      const key = args[1];
      const keys: Record<
        string,
        { code: string; windowsVirtualKeyCode: number; text?: string }
      > = {
        Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
        Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
        Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
        Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
        ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
        ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      };
      if (!keys[key])
        throw new Error(
          'Use Enter, Tab, Escape, Backspace or arrow keys; use cdp Input.dispatchKeyEvent for chords',
        );
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        ...keys[key],
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        ...keys[key],
        text: undefined,
      });
      return null;
    }
    throw new Error('Unknown browser operation');
  }
  private coordinates(x: unknown, y: unknown): void {
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > 10000 ||
      y > 10000
    )
      throw new Error(
        'Coordinates must be finite nonnegative CSS pixels, at most 10000',
      );
  }
  interrupt(): void {
    for (const item of this.targets.values()) {
      try {
        item.target.assert();
        item.target.interrupt();
      } catch {
        /* Already revoked by its owner. */
      }
    }
  }
  dispose(): void {
    this.playwright?.dispose();
    for (const item of this.targets.values()) item.dispose();
    this.targets.clear();
  }
}
