import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeInput, runtimeCommand } from './runtime-validation.js';

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
