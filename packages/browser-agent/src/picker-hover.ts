import type { BrowserHover } from '@elevenex/shared';
import { object } from './host.js';

/** Read-only hit testing for trusted human picker feedback. CDP supplies viewport
 * quads, including same-process frames and shadow DOM, without evaluating page code.
 * Out-of-process frames may resolve to their embedding element. */
export async function browserHoverAt(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  x: number,
  y: number,
): Promise<BrowserHover | undefined> {
  const hit = object(await send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }));
  const backendNodeId = hit['backendNodeId'];
  if (typeof backendNodeId !== 'number') return undefined;
  const node = object(object(await send('DOM.describeNode', { backendNodeId, depth: 0 }))['node']);
  const tag = node['localName'];
  if (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tag)) return undefined;
  const border = object(object(await send('DOM.getBoxModel', { backendNodeId }))['model'])['border'];
  if (!Array.isArray(border) || border.length !== 8 || !border.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1_000_000)) return undefined;
  const left = Math.min(border[0], border[2], border[4], border[6]), top = Math.min(border[1], border[3], border[5], border[7]);
  const width = Math.max(border[0], border[2], border[4], border[6]) - left, height = Math.max(border[1], border[3], border[5], border[7]) - top;
  return width > 0 && height > 0 ? { tag, x: left, y: top, width, height } : undefined;
}

/** One read at a time, latest pointer wins. Runs outside ordered input so a busy
 * page cannot delay scrolling or selection. Polling keeps a stationary pointer's
 * ring aligned through wheel momentum, page animation and layout changes. */
export class BrowserPickerHover {
  private pointer?: { x: number; y: number; current: () => boolean };
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private destroyed = false;
  value?: BrowserHover;
  constructor(
    private readonly read: (x: number, y: number) => Promise<BrowserHover | undefined>,
    private readonly changed: () => void,
  ) {}
  update(x: number, y: number, current: () => boolean): void {
    if (this.destroyed) return;
    this.pointer = { x, y, current };
    this.schedule();
  }
  reset(): void {
    this.pointer = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    this.publish(undefined);
  }
  destroy(): void { this.destroyed = true; this.reset(); }
  private publish(value: BrowserHover | undefined): void {
    if (JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value; this.changed();
  }
  private schedule(): void {
    if (this.destroyed || this.reading || this.timer || !this.pointer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 32);
  }
  private async refresh(): Promise<void> {
    const pointer = this.pointer;
    if (!pointer) return;
    if (!pointer.current()) { this.reset(); return; }
    this.reading = true;
    try {
      const value = await this.read(pointer.x, pointer.y);
      if (!this.destroyed && this.pointer === pointer && pointer.current()) this.publish(value);
    } catch {
      if (!this.destroyed && this.pointer === pointer) this.publish(undefined);
    } finally { this.reading = false; this.schedule(); }
  }
}
