import type { BrowserAgentCursor, BrowserAgentHighlight, BrowserAgentStep, BrowserPresentationCommand } from '@elevenex/shared';
import { object } from './host.js';

function fields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error('Unknown browser presentation field');
}
function coordinate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)
    throw new Error('Browser presentation coordinates must be finite and between 0 and 100000');
  return value;
}
export function browserAgentStep(value: unknown): BrowserAgentStep {
  const raw = object(value); fields(raw, ['n', 'total', 'text', 'status']);
  const n = raw['n'], total = raw['total'], text = raw['text'], status = raw['status'];
  if (!Number.isSafeInteger(n) || typeof n !== 'number' || n < 1 || n > 10000 ||
      (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < n || total > 10000)) ||
      typeof text !== 'string' || !text.trim() || text.length > 400 || Array.from(text).some(character => character.charCodeAt(0) < 32 && character !== '\t' && character !== '\n') ||
      (status !== undefined && status !== 'running' && status !== 'waiting' && status !== 'done' && status !== 'error'))
    throw new Error('Invalid browser step: supply n, optional total >= n, short text and a supported status');
  return { n, text: text.trim(), ...(total === undefined ? {} : { total }), ...(status === undefined ? {} : { status }) };
}
export function browserAgentHighlight(value: unknown): BrowserAgentHighlight {
  const raw = object(value); fields(raw, ['x', 'y', 'width', 'height', 'label']);
  const width = coordinate(raw['width']), height = coordinate(raw['height']), label = raw['label'];
  if (!width || !height || (label !== undefined && (typeof label !== 'string' || label.length > 120))) throw new Error('Invalid browser highlight');
  return { x: coordinate(raw['x']), y: coordinate(raw['y']), width, height, ...(typeof label === 'string' ? { label } : {}) };
}
export function browserAgentCursor(value: unknown): BrowserAgentCursor {
  const raw = object(value); fields(raw, ['x', 'y', 'pulse']);
  if (typeof raw['pulse'] !== 'number' || !Number.isSafeInteger(raw['pulse']) || raw['pulse'] < 0) throw new Error('Invalid browser cursor pulse');
  return { x: coordinate(raw['x']), y: coordinate(raw['y']), pulse: raw['pulse'] };
}
export function browserPresentationCommand(value: unknown): BrowserPresentationCommand {
  const raw = object(value);
  if (raw['kind'] === 'step') { fields(raw, ['kind', 'step']); return { kind: 'step', step: browserAgentStep(raw['step']) }; }
  if (raw['kind'] === 'hide-cursor') { fields(raw, ['kind']); return { kind: 'hide-cursor' }; }
  if (raw['kind'] !== 'cursor') throw new Error('Unknown browser presentation command');
  fields(raw, ['kind', 'point', 'highlight', 'pulse']);
  const point = object(raw['point']); fields(point, ['x', 'y']);
  if (raw['pulse'] !== undefined && typeof raw['pulse'] !== 'boolean') throw new Error('Invalid cursor pulse');
  return { kind: 'cursor', point: { x: coordinate(point['x']), y: coordinate(point['y']) },
    ...(raw['highlight'] === undefined ? {} : { highlight: browserAgentHighlight(raw['highlight']) }),
    ...(typeof raw['pulse'] === 'boolean' ? { pulse: raw['pulse'] } : {}) };
}

/** A page owns its latest feedback and one coalescing timer. Input never waits
 * for decorative motion, and revocation cannot flush a late cursor update. */
export class BrowserAgentPresentation {
  step?: BrowserAgentStep;
  cursor?: BrowserAgentCursor;
  highlight?: BrowserAgentHighlight;
  private pulse = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly changed: () => void) {}
  update(value: unknown): void {
    const command = browserPresentationCommand(value);
    if (this.disposed) throw new Error('Browser page closed');
    if (command.kind === 'step') {
      this.step = command.step;
      if (command.step.status === 'done' || command.step.status === 'error') this.clearPointer();
    } else if (command.kind === 'hide-cursor') this.clearPointer();
    else {
      this.cursor = { ...command.point, pulse: command.pulse ? ++this.pulse : this.pulse };
      this.highlight = command.highlight;
    }
    this.flush();
  }
  input(method: string, params: Record<string, unknown>): void {
    if (this.disposed || method !== 'Input.dispatchMouseEvent') return;
    if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(params['type']))) return;
    const x = params['x'], y = params['y'];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100000 || y > 100000) return;
    this.cursor = { x, y, pulse: params['type'] === 'mousePressed' ? ++this.pulse : this.pulse };
    if (params['type'] === 'mousePressed') this.flush();
    else this.timer ??= setTimeout(() => { this.timer = undefined; if (!this.disposed) this.changed(); }, 32);
  }
  clearPointer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.cursor = undefined; this.highlight = undefined;
  }
  clear(): void { this.clearPointer(); this.step = undefined; }
  interrupt(): void {
    if (this.disposed) return;
    const active = this.step && this.step.status !== 'done' && this.step.status !== 'error';
    const changed = active || this.cursor || this.highlight;
    this.clearPointer();
    if (active && this.step) this.step = { ...this.step, text: 'Browser work interrupted', status: 'error' };
    if (changed) this.flush();
  }
  dispose(): void { this.disposed = true; this.clear(); }
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.changed();
  }
}
