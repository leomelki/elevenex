import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeWatch } from './code-watch.service.js';
import { CodeSearch } from './code-search.service.js';
import type { CodeWorkspace } from './code-authorization.service.js';

jest.mock('@vscode/ripgrep', () => ({ rgPath: '' }));

describe('task directory watch reconciliation', () => {
  it('requests root reconciliation instead of acknowledging omitted folder invalidations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-watch-batch-'));
    const workspace: CodeWorkspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'b'.repeat(64), root: await realpath(directory), name: 'Task', branch: 'task' };
    const search = new CodeSearch(), watches = new CodeWatch(search);
    const native = jest.spyOn(jest.requireActual<typeof import('node:fs')>('node:fs'), 'watch');
    try {
      const folders = Array.from({ length: 129 }, (_, index) => join(workspace.root, `folder-${index}`));
      await Promise.all(folders.map(folder => mkdir(folder)));
      for (const folder of folders) {
        watches.observe(workspace, folder);
        // Deliver one native event per directory, independent of OS coalescing.
        const watcher = native.mock.results.at(-1)!;
        if (watcher.type !== 'return') throw new Error('Directory watcher did not start.');
        watcher.value.emit('change', 'created.txt');
      }
      const batch = watches.changes(workspace, 0);
      expect(batch.reset).toBe(true);
      expect(batch.paths).toEqual(['/']);
      expect(watches.changes(workspace, batch.sequence).paths).toEqual([]);
    } finally { native.mockRestore(); watches.onModuleDestroy(); search.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); }
  });
  it('reports real changes, releases ownership and bounds repeated watcher failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'code-watch-'));
    const workspace: CodeWorkspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'b'.repeat(64), root: await realpath(directory), name: 'Task', branch: 'task' };
    const search = new CodeSearch(), watches = new CodeWatch(search);
    try {
      const initial = watches.changes(workspace, 0);
      await writeFile(join(directory, 'created.txt'), 'new');
      const deadline = Date.now() + 3000;
      while (watches.changes(workspace, initial.sequence).sequence === initial.sequence && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const changed = watches.changes(workspace, initial.sequence);
      expect(changed.sequence).toBeGreaterThan(initial.sequence);
      expect(changed.paths).toContain('/');
      watches.release(workspace.identity);
      expect(watches.changes(workspace, changed.sequence).reset).toBe(true);
      for (let index = 0; index < 600; index++) watches.observe(workspace, join(directory, 'missing', String(index)));
      const overflow = watches.changes(workspace, 0);
      expect(overflow.reset).toBe(true);
      expect(overflow.paths).toEqual(['/']);
    } finally { watches.onModuleDestroy(); search.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); }
  });
});
