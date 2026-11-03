import type { BrowserAgentCommand, BrowserRect, TaskBrowserCommand, TaskBrowserLayout } from '@elevenex/shared';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser input');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected browser argument');
}
export function browserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid browser identity');
  return value;
}
export function taskId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid task');
  return value;
}
export function browserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || (/\s/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new Error('Enter an HTTP or HTTPS address');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS pages without credentials are allowed');
  return url.href;
}
export function loopback(url: URL): boolean {
  // URL canonicalizes legacy numeric IPv4 and IPv6 forms before this check.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || /^127\./.test(host) || host === '[::1]' || host === '[::]') return true;
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(host);
  return !!mapped && ((parseInt(mapped[1]!, 16) >>> 8) === 127 || (parseInt(mapped[1]!, 16) === 0 && parseInt(mapped[2]!, 16) === 0));
}
export function layout(value: unknown): TaskBrowserLayout {
  const raw = record(value); exact(raw, ['sequence', 'surfaceEpoch', 'visible', 'inputReady', 'ownerGeneration', 'bounds', 'reducedMotion']);
  const box = record(raw['bounds']); exact(box, ['x', 'y', 'width', 'height']);
  if (typeof raw['inputReady'] !== 'boolean' || !Number.isSafeInteger(raw['ownerGeneration']) || Number(raw['ownerGeneration']) < 0 || !Number.isSafeInteger(raw['surfaceEpoch']) || Number(raw['surfaceEpoch']) < 0 || typeof raw['reducedMotion'] !== 'boolean' || typeof raw['visible'] !== 'boolean' || !Number.isSafeInteger(raw['sequence']) || Number(raw['sequence']) < 0) throw new Error('Invalid browser layout');
  for (const key of ['x', 'y', 'width', 'height']) if (typeof box[key] !== 'number' || !Number.isFinite(box[key]) || Number(box[key]) < 0 || Number(box[key]) > 16384) throw new Error('Invalid browser bounds');
  return { inputReady: raw['inputReady'], ownerGeneration: Number(raw['ownerGeneration']), surfaceEpoch: Number(raw['surfaceEpoch']), sequence: Number(raw['sequence']), reducedMotion: raw['reducedMotion'], visible: raw['visible'], bounds: { x: Number(box['x']), y: Number(box['y']), width: Number(box['width']), height: Number(box['height']) } };
}
export function command(value: unknown): TaskBrowserCommand {
  const raw = record(value), kind = raw['kind'];
  if (kind === 'open') { exact(raw, ['kind', 'url']); return { kind, url: browserUrl(raw['url']) }; }
  if (kind === 'pick' || kind === 'feedback') { exact(raw, ['kind', 'enabled']); if (typeof raw['enabled'] !== 'boolean') throw new Error('Invalid browser toggle'); return { kind, enabled: raw['enabled'] }; }
  const tabId = browserId(raw['tabId']);
  if (kind === 'handoff') { exact(raw, ['kind', 'tabId', 'sessionId']); return { kind, tabId, sessionId: taskId(raw['sessionId']) }; }
  if (kind === 'navigate') { exact(raw, ['kind', 'tabId', 'url']); return { kind, tabId, url: browserUrl(raw['url']) }; }
  if (kind === 'width') { exact(raw, ['kind', 'tabId', 'width']); if (raw['width'] !== 'phone' && raw['width'] !== 'full') throw new Error('Invalid width'); return { kind, tabId, width: raw['width'] }; }
  if (kind === 'theme') { exact(raw, ['kind', 'tabId', 'theme']); if (!['light', 'dark', 'system'].includes(String(raw['theme']))) throw new Error('Invalid page theme'); return { kind, tabId, theme: raw['theme'] as 'light' | 'dark' | 'system' }; }
  if (kind === 'network') { exact(raw, ['kind', 'tabId', 'slow']); if (typeof raw['slow'] !== 'boolean') throw new Error('Invalid network setting'); return { kind, tabId, slow: raw['slow'] }; }
  if (kind !== 'select' && kind !== 'close' && kind !== 'back' && kind !== 'reload' && kind !== 'takeover' && kind !== 'outside' && kind !== 'focus') throw new Error('Unsupported browser command');
  exact(raw, ['kind', 'tabId']); return { kind, tabId };
}
export function agentCommand(value: unknown): BrowserAgentCommand {
  const raw = record(value), kind = raw['kind'];
  if (kind === 'list') { exact(raw, ['kind']); return { kind }; }
  if (kind === 'open') { exact(raw, ['kind', 'url']); return { kind, url: browserUrl(raw['url']) }; }
  const tabId = browserId(raw['tabId']), generation = taskId(raw['generation']);
  if (kind === 'navigate') { exact(raw, ['kind', 'tabId', 'generation', 'url']); return { kind, tabId, generation, url: browserUrl(raw['url']) }; }
  if (kind === 'click' || kind === 'scroll') {
    exact(raw, ['kind', 'tabId', 'generation', 'x', 'y', ...(kind === 'click' ? ['step', 'n', 'total'] : ['atX', 'atY'])]);
    const x = raw['x'], y = raw['y'];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 16000 || Math.abs(y) > 16000) throw new Error('Invalid page coordinates');
    if (kind === 'scroll') {
      const atX = raw['atX'], atY = raw['atY'];
      for (const point of [atX, atY]) if (point !== undefined && (typeof point !== 'number' || !Number.isFinite(point) || point < 0 || point > 16000)) throw new Error('Invalid scroll target');
      return { kind, tabId, generation, x, y, ...(typeof atX === 'number' ? { atX } : {}), ...(typeof atY === 'number' ? { atY } : {}) };
    }
    if (typeof raw['step'] !== 'string' || raw['step'].length > 160) throw new Error('Invalid browser step');
    const n = raw['n'] === undefined ? 1 : taskId(raw['n']), total = raw['total'] === undefined ? undefined : taskId(raw['total']);
    if (n > 1000 || (total !== undefined && (total < n || total > 1000))) throw new Error('Invalid workflow progress');
    return { kind, tabId, generation, x, y, step: raw['step'], n, ...(total === undefined ? {} : { total }) };
  }
  if (kind !== 'back' && kind !== 'reload' && kind !== 'needs-user' && kind !== 'select' && kind !== 'close') throw new Error('Unsupported browser action; text entry and page observation are withheld');
  exact(raw, ['kind', 'tabId', 'generation']); return { kind, tabId, generation };
}
export function intersect(box: BrowserRect, width: number, height: number): BrowserRect {
  const x = Math.max(0, Math.ceil(box.x)), y = Math.max(0, Math.ceil(box.y));
  return { x, y, width: Math.max(0, Math.floor(Math.min(box.x + box.width, width)) - x), height: Math.max(0, Math.floor(Math.min(box.y + box.height, height)) - y) };
}
