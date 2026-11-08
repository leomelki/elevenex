import { browserLoopbackHost } from '@elevenex/browser-network';
import type { TaskBrowserWindowContext, BrowserAgentCommand, BrowserRect, TaskBrowserCommand, TaskBrowserLayout, TaskBrowserStreamInput, TaskBrowserStreamEvent } from '@elevenex/shared';

export function streamInput(value: unknown): TaskBrowserStreamInput {
  const raw = record(value);
  if (raw['kind'] !== 'batch') return streamEvent(value);
  exact(raw, ['kind', 'events']);
  if (!Array.isArray(raw['events']) || !raw['events'].length || raw['events'].length > 32) throw new Error('Invalid input batch');
  const events = raw['events'].map(streamEvent);
  if (events.some(event => event.kind === 'clipboard' || event.kind === 'release') || events.reduce((size, event) => size + (event.kind === 'text' || event.kind === 'composition' || event.kind === 'key' ? event.text?.length ?? 0 : 0), 0) > 65536) throw new Error('Input batch exceeded its bounds');
  return { kind: 'batch', events };
}
function streamEvent(value: unknown): TaskBrowserStreamEvent {
  const raw = record(value), kind = raw['kind'];
  const number = (key: string, min: number, max: number): number => { const n = raw[key]; if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error('Invalid browser input'); return n; };
  const integer = (key: string, min: number, max: number): number => { const n = number(key, min, max); if (!Number.isSafeInteger(n)) throw new Error('Invalid browser input integer'); return n; };
  const text = (key: string, max: number): string => { const s = raw[key]; if (typeof s !== 'string' || s.length > max) throw new Error('Invalid browser input'); return s; };
  if (kind === 'release' || kind === 'pointer-exit') { exact(raw, ['kind']); return { kind }; }
  const lockEpoch = () => raw['pointerLockEpoch'] === undefined ? {} : { pointerLockEpoch: integer('pointerLockEpoch', 1, Number.MAX_SAFE_INTEGER) };
  if (kind === 'pointer-unlock') { exact(raw, ['kind', 'pointerLockEpoch']); return { kind, ...lockEpoch() }; }
  if (kind === 'pointer-relative') { exact(raw, ['kind', 'deltaX', 'deltaY', 'buttons', 'modifiers', 'pointerLockEpoch']); return { kind, deltaX: number('deltaX', -10000, 10000), deltaY: number('deltaY', -10000, 10000), buttons: integer('buttons', 0, 31), modifiers: integer('modifiers', 0, 15), ...lockEpoch() }; }
  if (kind === 'text') { exact(raw, ['kind', 'text']); return { kind, text: text('text', 65536) }; }
  if (kind === 'composition') {
    exact(raw, ['kind', 'text', 'selectionStart', 'selectionEnd']);
    const value = text('text', 4096), selectionStart = integer('selectionStart', 0, value.length);
    return { kind, text: value, selectionStart, selectionEnd: integer('selectionEnd', selectionStart, value.length) };
  }
  if (kind === 'edit') { exact(raw, ['kind', 'operation']); const operation=raw['operation'];if(operation!=='undo'&&operation!=='redo')throw new Error('Invalid edit operation');return {kind,operation}; }
  if (kind === 'clipboard') { exact(raw, ['kind', 'operation']); const operation = raw['operation']; if (operation !== 'copy' && operation !== 'cut' && operation !== 'paste' && operation !== 'selectAll') throw new Error('Invalid clipboard action'); return { kind, operation }; }
  if (kind === 'key') { exact(raw, ['kind', 'type', 'key', 'code', 'keyCode', 'modifiers', 'text']); const type = raw['type']; if (type !== 'down' && type !== 'up' || (raw['text'] !== undefined && type !== 'down')) throw new Error('Invalid key action'); return { kind, type, key: text('key', 80), code: text('code', 80), keyCode: integer('keyCode', 0, 255), modifiers: integer('modifiers', 0, 15), ...(raw['text'] === undefined ? {} : { text: text('text', 65536) }) }; }
  const x = number('x', 0, 16384), y = number('y', 0, 16384), modifiers = integer('modifiers', 0, 15);
  if (kind === 'wheel') { exact(raw, ['kind', 'x', 'y', 'deltaX', 'deltaY', 'modifiers']); return { kind, x, y, modifiers, deltaX: number('deltaX', -10000, 10000), deltaY: number('deltaY', -10000, 10000) }; }
  if (kind !== 'pointer') throw new Error('Unsupported browser input');
  exact(raw, ['kind', 'type', 'x', 'y', 'button', 'buttons', 'clicks', 'modifiers']);
  const type = raw['type'], button = raw['button'];
  if ((type !== 'down' && type !== 'up' && type !== 'move') || (button !== 'left' && button !== 'right' && button !== 'middle' && button !== 'none')) throw new Error('Invalid pointer action');
  return { kind, type, button, x, y, modifiers, buttons: integer('buttons', 0, 31), clicks: integer('clicks', 0, 3) };
}

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
export function loopback(url: URL): boolean { return browserLoopbackHost(url.hostname); }
export function layout(value: unknown): TaskBrowserLayout {
  const raw = record(value); exact(raw, ['sequence', 'surfaceEpoch', 'visible', 'inputReady', 'ownerGeneration', 'bounds', 'reducedMotion', 'viewport']);
  const box = record(raw['bounds']); exact(box, ['x', 'y', 'width', 'height']);
  if (typeof raw['inputReady'] !== 'boolean' || !Number.isSafeInteger(raw['ownerGeneration']) || Number(raw['ownerGeneration']) < 0 || !Number.isSafeInteger(raw['surfaceEpoch']) || Number(raw['surfaceEpoch']) < 0 || typeof raw['reducedMotion'] !== 'boolean' || typeof raw['visible'] !== 'boolean' || !Number.isSafeInteger(raw['sequence']) || Number(raw['sequence']) < 0) throw new Error('Invalid browser layout');
  for (const key of ['x', 'y', 'width', 'height']) if (typeof box[key] !== 'number' || !Number.isFinite(box[key]) || Number(box[key]) < 0 || Number(box[key]) > 16384) throw new Error('Invalid browser bounds');
  const viewport = raw['viewport'] === undefined ? undefined : record(raw['viewport']);
  if (viewport) { exact(viewport, ['width', 'height']); for (const key of ['width','height']) if(typeof viewport[key] !== 'number' || !Number.isFinite(viewport[key]) || Number(viewport[key]) < 0 || Number(viewport[key]) > 16384) throw new Error('Invalid browser viewport'); }
  return { ...(viewport ? { viewport: { width: Number(viewport['width']), height: Number(viewport['height']) } } : {}), inputReady: raw['inputReady'], ownerGeneration: Number(raw['ownerGeneration']), surfaceEpoch: Number(raw['surfaceEpoch']), sequence: Number(raw['sequence']), reducedMotion: raw['reducedMotion'], visible: raw['visible'], bounds: { x: Number(box['x']), y: Number(box['y']), width: Number(box['width']), height: Number(box['height']) } };
}
export function command(value: unknown): TaskBrowserCommand {
  const raw = record(value), kind = raw['kind'];
  if (kind === 'dismiss-attention' || kind === 'new-tab') { exact(raw, ['kind']); return { kind }; }
  if (kind === 'open') { exact(raw, ['kind', 'url']); return { kind, url: browserUrl(raw['url']) }; }
  if (kind === 'pick' || kind === 'feedback') { exact(raw, ['kind', 'enabled']); if (typeof raw['enabled'] !== 'boolean') throw new Error('Invalid browser toggle'); return { kind, enabled: raw['enabled'] }; }
  const tabId = browserId(raw['tabId']);
  if (kind === 'choose-files' || kind === 'save-download' || kind === 'cancel-workflow') { exact(raw, ['kind', 'tabId', 'requestId']); return { kind, tabId, requestId: browserId(raw['requestId']) }; }
  if (kind === 'dialog-response') { exact(raw, ['kind', 'tabId', 'requestId', 'accept', 'text']); if (typeof raw['accept'] !== 'boolean' || typeof raw['text'] !== 'string' || raw['text'].length > 4096) throw new Error('Invalid dialog response'); return { kind, tabId, requestId: browserId(raw['requestId']), accept: raw['accept'], text: raw['text'] }; }
  if (kind === 'move-tab') { exact(raw, ['kind', 'tabId', 'beforeTabId']); return { kind, tabId, beforeTabId: raw['beforeTabId'] === null ? null : browserId(raw['beforeTabId']) }; }
  if (kind === 'handoff') { exact(raw, ['kind', 'tabId', 'sessionId']); return { kind, tabId, sessionId: taskId(raw['sessionId']) }; }
  if (kind === 'navigate') { exact(raw, ['kind', 'tabId', 'url']); return { kind, tabId, url: browserUrl(raw['url']) }; }
  if (kind === 'width') { exact(raw, ['kind', 'tabId', 'width']); if (raw['width'] !== 'phone' && raw['width'] !== 'full') throw new Error('Invalid width'); return { kind, tabId, width: raw['width'] }; }
  if (kind === 'theme') { exact(raw, ['kind', 'tabId', 'theme']); if (!['light', 'dark', 'system'].includes(String(raw['theme']))) throw new Error('Invalid page theme'); return { kind, tabId, theme: raw['theme'] as 'light' | 'dark' | 'system' }; }
  if (kind === 'network') { exact(raw, ['kind', 'tabId', 'slow']); if (typeof raw['slow'] !== 'boolean') throw new Error('Invalid network setting'); return { kind, tabId, slow: raw['slow'] }; }
  if (kind !== 'select' && kind !== 'close' && kind !== 'back' && kind !== 'forward' && kind !== 'reload' && kind !== 'takeover' && kind !== 'outside' && kind !== 'focus') throw new Error('Unsupported browser command');
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

export function windowContext(value: unknown): TaskBrowserWindowContext {
  const raw = record(value);
  exact(raw, ['projectName', 'taskName', 'branchName', 'machineName', 'stage', 'hue']);
  for (const key of ['projectName', 'taskName', 'branchName', 'machineName'])
    if (typeof raw[key] !== 'string' || raw[key].length > 256 || [...raw[key]].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid browser window label');
  const stage = raw['stage'], hue = raw['hue'];
  if (stage !== 'planned' && stage !== 'active' && stage !== 'waiting' && stage !== 'closed') throw new Error('Invalid task stage');
  if (hue !== 'ocean' && hue !== 'pine' && hue !== 'plum' && hue !== 'rust' && hue !== 'steel' && hue !== 'rose') throw new Error('Invalid project hue');
  return { projectName: String(raw['projectName']), taskName: String(raw['taskName']), branchName: String(raw['branchName']), machineName: String(raw['machineName']), stage, hue };
}
