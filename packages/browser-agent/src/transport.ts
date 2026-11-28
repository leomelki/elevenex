import { isBrowserElementSnapshot } from '@elevenex/shared';
import type {
  BrowserCodeCommand,
  BrowserCodeResult,
  BrowserCodeImage,
} from '@elevenex/shared';
import { integer, object } from './host.js';

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error('Unexpected browser code field');
}
export function browserCodeCommand(value: unknown): BrowserCodeCommand {
  const input = object(value);
  exact(input, ['kind', 'code', 'timeoutMs', 'reset', 'api']);
  if (
    (input['api'] !== undefined && input['api'] !== 2) ||
    input['kind'] !== 'code' ||
    typeof input['code'] !== 'string' ||
    input['code'].length > 65536 ||
    (input['reset'] !== undefined && typeof input['reset'] !== 'boolean')
  )
    throw new Error('Invalid browser code request');
  return {
    kind: 'code',
    ...(input['api'] === 2 ? { api: 2 as const } : {}),
    code: input['code'],
    timeoutMs: integer(input['timeoutMs'], 15000, 250, 60000),
    ...(input['reset'] === true ? { reset: true } : {}),
  };
}
export function browserCodeResult(value: unknown): BrowserCodeResult {
  const input = object(value);
  exact(input, ['sandboxId', 'value', 'logs', 'images', 'error', 'requests']);
  if (
    typeof input['sandboxId'] !== 'string' ||
    input['sandboxId'].length > 36 ||
    !Array.isArray(input['logs']) ||
    input['logs'].length > 100 ||
    input['logs'].some((log) => typeof log !== 'string') ||
    input['logs'].join('').length > 32000 ||
    !Array.isArray(input['images']) ||
    input['images'].length > 4 ||
    Buffer.byteLength(JSON.stringify(input['value'] ?? null)) > 1048576
  )
    throw new Error('Invalid browser code result');
  const images: BrowserCodeImage[] = input['images'].map((raw: unknown) => {
    const image = object(raw);
    exact(image, ['data', 'mimeType', 'width', 'height']);
    if (
      typeof image['data'] !== 'string' ||
      image['data'].length > 5592408 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(image['data']) ||
      !['image/jpeg', 'image/png'].includes(String(image['mimeType']))
    )
      throw new Error('Invalid browser image');
    return {
      data: image['data'],
      mimeType: image['mimeType'] as BrowserCodeImage['mimeType'],
      width: integer(image['width'], 0, 1, 16384),
      height: integer(image['height'], 0, 1, 16384),
    };
  });
  let error: BrowserCodeResult['error'];
  if (input['error'] !== undefined) {
    const detail = object(input['error']);
    exact(detail, ['message', 'outcomeUnknown']);
    if (
      typeof detail['message'] !== 'string' ||
      detail['message'].length > 4096 ||
      typeof detail['outcomeUnknown'] !== 'boolean'
    )
      throw new Error('Invalid browser error');
    error = {
      message: detail['message'],
      outcomeUnknown: detail['outcomeUnknown'],
    };
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 12500000)
    throw new Error('Browser reply exceeded transport limit');
  return {
    sandboxId: input['sandboxId'],
    value: input['value'] ?? null,
    logs: input['logs'] as string[],
    images,
    ...(input['requests'] === undefined
      ? {}
      : { requests: browserHumanRequests(input['requests']) }),
    ...(error ? { error } : {}),
  };
}

export function browserHumanRequests(
  value: unknown,
  maximum = 4,
): import('@elevenex/shared').BrowserHumanRequest[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error('Invalid browser request list');
  return value.map((raw) => {
    const item = object(raw);
    exact(item, [
      'id',
      'tabId',
      'sessionId',
      'kind',
      'message',
      'status',
      'expiresAt',
      'selection',
    ]);
    if (
      typeof item['id'] !== 'string' ||
      item['id'].length > 80 ||
      typeof item['tabId'] !== 'string' ||
      item['tabId'].length > 80 ||
      !['action', 'element'].includes(String(item['kind'])) ||
      typeof item['message'] !== 'string' ||
      item['message'].length > 2000 ||
      !['pending', 'completed', 'cancelled', 'expired'].includes(
        String(item['status']),
      )
    )
      throw new Error('Invalid human request');
    const selection =
      item['selection'] === undefined
        ? undefined
        : browserHumanElement(item['selection']);
    if (selection?.snapshot && selection.snapshot.reference.tabId !== item['tabId']) throw new Error('Snapshot belongs to another tab');
    return {
      id: item['id'],
      tabId: item['tabId'],
      sessionId: integer(item['sessionId'], 0, 1, Number.MAX_SAFE_INTEGER),
      kind: item['kind'] as 'action' | 'element',
      message: item['message'],
      status: item[
        'status'
      ] as import('@elevenex/shared').BrowserHumanRequest['status'],
      expiresAt: integer(item['expiresAt'], 0, 0, Number.MAX_SAFE_INTEGER),
      ...(selection ? { selection } : {}),
    };
  });
}
function browserHumanElement(
  value: unknown,
): import('@elevenex/shared').BrowserHumanElement {
  const item = object(value);
  exact(item, [
    'selector',
    'frames',
    'tag',
    'x',
    'y',
    'width',
    'height',
    'documentId',
    'frameId',
    'loaderId',
    'snapshot',
  ]);
  if (
    typeof item['selector'] !== 'string' ||
    item['selector'].length > 2048 ||
    !Array.isArray(item['frames']) ||
    item['frames'].length > 16 ||
    item['frames'].some(
      (value) => typeof value !== 'string' || value.length > 2048,
    ) ||
    typeof item['tag'] !== 'string' ||
    item['tag'].length > 64 ||
    typeof item['documentId'] !== 'string' ||
    item['documentId'].length > 200
  )
    throw new Error('Invalid element selection');
  for (const key of ['x', 'y', 'width', 'height'])
    if (
      typeof item[key] !== 'number' ||
      !Number.isFinite(item[key]) ||
      Math.abs(item[key]) > 1000000
    )
      throw new Error('Invalid selection geometry');
  for (const key of ['frameId', 'loaderId'])
    if (
      item[key] !== undefined &&
      (typeof item[key] !== 'string' || item[key].length > 100)
    )
      throw new Error('Invalid selection document identity');
  const snapshot = item['snapshot'];
  if (snapshot !== undefined && (!isBrowserElementSnapshot(snapshot) || snapshot.reference.documentId !== item['documentId'] || snapshot.reference.selector !== item['selector'] || JSON.stringify(snapshot.reference.frames) !== JSON.stringify(item['frames']))) throw new Error('Invalid element snapshot identity');
  return {
    ...(isBrowserElementSnapshot(snapshot) ? { snapshot } : {}),
    selector: item['selector'],
    frames: item['frames'] as string[],
    tag: item['tag'],
    documentId: item['documentId'],
    x: Number(item['x']),
    y: Number(item['y']),
    width: Number(item['width']),
    height: Number(item['height']),
    ...(typeof item['frameId'] === 'string'
      ? { frameId: item['frameId'] }
      : {}),
    ...(typeof item['loaderId'] === 'string'
      ? { loaderId: item['loaderId'] }
      : {}),
  };
}
