// Resolve the actual packaged ripgrep binary without asking Jest to evaluate
// the package's ESM loader. Search subprocesses remain real.
jest.mock('@vscode/ripgrep', () => {
  const { createRequire } = jest.requireActual<typeof import('node:module')>('node:module');
  const load = createRequire(require.resolve('@vscode/ripgrep'));
  return { rgPath: load.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`) };
});
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CodeWorkspace } from './code-authorization.service.js';
import { CodeSearch } from './code-search.service.js';
describe('new task search with actual ripgrep', () => {
  let root: string, workspace: CodeWorkspace, search: CodeSearch;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'new-code-search-'))); await mkdir(join(root, 'task'));
    workspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), root: join(root, 'task'), name: 'Task', branch: 'task' };
    await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(workspace.root, `file-${String(i).padStart(5, '0')}.ts`), `export const searchable = "needle ${i}";\n`)));
    await writeFile(join(workspace.root, '.gitignore'), 'ignored/\n'); await mkdir(join(workspace.root, 'ignored')); await writeFile(join(workspace.root, 'ignored/private'), 'needle');
    await mkdir(join(workspace.root, '.git')); await writeFile(join(workspace.root, '.git/config'), 'needle');
    await writeFile(join(root, 'outside'), 'needle outside'); await symlink(join(root, 'outside'), join(workspace.root, 'escape'));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  beforeEach(() => { search = new CodeSearch(); });
  afterEach(() => search.onModuleDestroy());
  it('streams bounded pages, enforces a total limit and excludes escapes and ignores', async () => {
    let page = await search.start(workspace, { query: 'needle', limit: 350 });
    const rows = [...page.rows]; expect(page.rows.length).toBeLessThanOrEqual(100);
    while (!page.done) { page = await search.page(workspace, page.id); expect(page.rows.length).toBeLessThanOrEqual(100); rows.push(...page.rows); }
    expect(rows).toHaveLength(350); expect(page.limited).toBe(true);
    expect(rows.some(r => /ignored|escape|\.git/.test(r.path))).toBe(false);
    expect(rows.every(r => r.line === 0 && r.start >= 0 && r.end > r.start)).toBe(true);
  });
  it('honors filename globs and ignore settings without letting patterns include Git metadata', async () => {
    expect((await search.filenames(workspace, { query: 'file-02099', excludes: ['**/*.ts'] })).paths).toEqual([]);
    expect((await search.filenames(workspace, { query: 'private', useIgnoreFiles: false, includes: ['ignored/**'] })).paths).toEqual(['/ignored/private']);
    expect((await search.filenames(workspace, { query: 'config', useIgnoreFiles: false, includes: ['**'] })).paths).toEqual([]);
  });
  it('cancels obsolete searches and isolates result cursors to their workspace', async () => {
    const page = await search.start(workspace, { query: 'needle' });
    await expect(search.page({ ...workspace, identity: 'b'.repeat(64) }, page.id)).rejects.toThrow('expired');
    search.cancel(workspace, page.id); await expect(search.page(workspace, page.id)).rejects.toThrow('expired');
  });
  it('enforces the per-task search budget for concurrently arriving requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => search.start(workspace, { query: 'needle' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('reuses bounded filename indexes across keystrokes', async () => {
    const first = await search.filenames(workspace, { query: 'file', limit: 20 });
    expect(first.paths).toHaveLength(20); expect(first.limited).toBe(true);
    const second = await search.filenames(workspace, { query: 'file-02099' });
    expect(second.paths).toEqual(['/file-02099.ts']);
    expect((await search.filenames(workspace, { query: 'private' })).paths).toEqual([]);
  });
});
