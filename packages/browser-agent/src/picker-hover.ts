import type { BrowserHover } from '@elevenex/shared';
import { object } from './host.js';
import { selectionFingerprintExpression } from './element-selection.js';

/** A single bounded main-document hit test in CSS viewport coordinates. Reading
 * the page's layout avoids compositor hit tests lagging behind wheel scrolling.
 * Open shadow roots are resolved; closed roots and frames remain opaque here. */
export async function browserHoverAt(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<BrowserHover | undefined> {
  signal?.throwIfAborted();
  const reply = object(await send('Runtime.evaluate', {
    expression: selectionFingerprintExpression(x, y), returnByValue: true, timeout: 50, silent: true, disableBreaks: true,
  }));
  signal?.throwIfAborted();
  if (reply['exceptionDetails']) throw new Error('Picker hit test interrupted');
  const value = object(reply['result'])['value'];
  if (!value || typeof value !== 'object') return undefined;
  const raw = object(value), tag = raw['tag'];
  if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return undefined;
  const coordinate = (key: string): number | undefined => {
    const n = raw[key];
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000 ? n : undefined;
  };
  const left = coordinate('x'), top = coordinate('y'), width = coordinate('width'), height = coordinate('height');
  return left !== undefined && top !== undefined && width !== undefined && height !== undefined && width > 0 && height > 0 ? { tag, x: left, y: top, width, height } : undefined;
}

/** Latest-position sampling outside ordered input. Moving the pointer must not
 * starve completed samples. Only a changed document/picker lifetime invalidates
 * a sample. Motion is sampled at most once per 32 ms; a stationary pointer only
 * needs occasional layout reconciliation. Slow pages back off, and a stalled
 * command cannot accumulate more work behind it in Chromium. */
export class BrowserPickerHover {
  private pointer?: { x: number; y: number; current: () => boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: AbortController;
  private pending = 0;
  private nextRead = 0;
  private lastRead = 0;
  private backoff = 0;
  private epoch = 0;
  private destroyed = false;
  value?: BrowserHover;
  constructor(
    private readonly read: (x: number, y: number, signal: AbortSignal) => Promise<BrowserHover | undefined>,
    private readonly changed: () => void,
  ) {}
  update(x: number, y: number, current: () => boolean): void {
    if (this.destroyed) return;
    this.pointer = { x, y, current };
    if (!this.backoff && !this.reading && !this.pending) {
      this.nextRead = Math.min(this.nextRead, this.lastRead + 32);
      clearTimeout(this.timer); this.timer = undefined;
    }
    this.schedule();
  }
  pause(): void { this.reset(false); }
  reset(clear = true): void {
    this.epoch++;
    this.pointer = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    this.reading?.abort(); this.reading = undefined;
    this.nextRead = 0; this.lastRead = 0; this.backoff = 0;
    if (clear) this.publish(undefined);
  }
  destroy(): void { this.destroyed = true; this.reset(); }
  private publish(value: BrowserHover | undefined): void {
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value; this.changed();
  }
  private schedule(): void {
    if (this.destroyed || this.reading || this.pending || this.timer || !this.pointer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, Math.max(0, this.nextRead - performance.now()));
  }
  private async refresh(): Promise<void> {
    const pointer = this.pointer, epoch = this.epoch;
    if (!pointer) return;
    if (!pointer.current()) { this.reset(); return; }
    const controller = new AbortController();
    this.reading = controller;
    const deadline = setTimeout(() => controller.abort(), 200);
    this.pending++;
    // Cancellation cannot cancel a Chromium command already in progress. Count
    // those commands until they settle so a blocked page never grows a queue.
    const operation = Promise.resolve().then(() => this.read(pointer.x, pointer.y, controller.signal));
    void operation.finally(() => { this.pending--; this.schedule(); }).catch(() => undefined);
    let stop: () => void = () => undefined;
    let failed = false;
    try {
      const aborted = new Promise<undefined>(resolve => {
        stop = () => resolve(undefined);
        controller.signal.addEventListener('abort', stop, { once: true });
      });
      const value = await Promise.race([operation, aborted]);
      if (!this.destroyed && epoch === this.epoch && pointer.current()) this.publish(value);
    } catch {
      failed = true;
      if (!this.destroyed && epoch === this.epoch) this.publish(undefined);
    } finally {
      clearTimeout(deadline); controller.signal.removeEventListener('abort', stop);
      if (this.reading === controller) this.reading = undefined;
      if (epoch === this.epoch) {
        this.backoff = failed || controller.signal.aborted ? Math.min(2000, Math.max(250, this.backoff * 2)) : 0;
        this.lastRead = performance.now();
        this.nextRead = this.lastRead + (this.backoff || (this.pointer === pointer ? 200 : 32));
      }
      this.schedule();
    }
  }
}
