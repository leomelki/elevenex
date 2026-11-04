import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeInput } from './runtime-validation.js';

it('satisfies the same human input protocol cases as Electron', async () => {
  const cases: { valid: boolean; input: unknown }[] = JSON.parse(await readFile(join(__dirname, '../../../../test/fixtures/task-browser-input.json'), 'utf8'));
  for (const { valid, input } of cases) expect(runtimeInput.safeParse(input).success).toBe(valid);
});
