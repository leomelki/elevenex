import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeInput, runtimeCommand, runtimeTransfer } from './runtime-validation.js';

it('accepts forward navigation only for a valid tab with no extra fields', () => {
  const tabId = '11111111-1111-4111-8111-111111111111';
  expect(runtimeCommand.safeParse({ kind: 'forward', tabId }).success).toBe(true);
  expect(runtimeCommand.safeParse({ kind: 'forward', tabId: 'missing' }).success).toBe(false);
  expect(runtimeCommand.safeParse({ kind: 'forward', tabId, url: 'https://example.com' }).success).toBe(false);
});

it('satisfies the same human input protocol cases as Electron', async () => {
  const cases: { valid: boolean; input: unknown }[] = JSON.parse(await readFile(join(__dirname, '../../../../test/fixtures/task-browser-input.json'), 'utf8'));
  for (const { valid, input } of cases) expect(runtimeInput.safeParse(input).success).toBe(valid);
});

it('validates bounded stable tab moves without accepting a replacement tab set', () => {
  const tabId = '11111111-1111-4111-8111-111111111111';
  for (const beforeTabId of [null, tabId]) expect(runtimeCommand.safeParse({ kind: 'move-tab', tabId, beforeTabId }).success).toBe(true);
  for (const beforeTabId of [undefined, 0, 'missing', [], {}]) expect(runtimeCommand.safeParse({ kind: 'move-tab', tabId, beforeTabId }).success).toBe(false);
  expect(runtimeCommand.safeParse({ kind: 'move-tab', tabId, beforeTabId: null, tabs: [] }).success).toBe(false);
});

it('confines file transfer requests to viewer IDs, finite chunks and basename metadata', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const message = { tabId: id, requestId: id, transfer: { kind: 'upload-start', files: [{ name: 'image.png', size: 1024 }] } };
  expect(runtimeTransfer.safeParse(message).success).toBe(true);
  for (const name of ['../secret', '/tmp/secret', '..', 'bad\\name']) expect(runtimeTransfer.safeParse({ ...message, transfer: { ...message.transfer, files: [{ name, size: 1 }] } }).success).toBe(false);
  expect(runtimeTransfer.safeParse({ ...message, hostPath: '/tmp/file' }).success).toBe(false);
  expect(runtimeTransfer.safeParse({ tabId: id, requestId: id, transfer: { kind: 'upload-chunk', index: 0, offset: 0, data: 'a'.repeat(65537) } }).success).toBe(false);
  expect(runtimeInput.safeParse({ kind: 'pointer-relative', deltaX: Infinity, deltaY: 0, buttons: 0, modifiers: 0 }).success).toBe(false);
});
