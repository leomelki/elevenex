import { chmod, lstat, mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeDelete, codeDirectory, codeMkdir, codeRead, codeRename, codeStat, codeWrite, confinedPath } from './code-files.js';
import type { CodeWorkspace } from './code-authorization.service.js';

describe('new task filesystem public behavior', () => {
  let directory: string, workspace: CodeWorkspace;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'new-code-files-')); workspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), root: join(directory, 'task'), name: 'Task', branch: 'task' }; await mkdir(workspace.root); workspace = { ...workspace, root: await realpath(workspace.root) }; });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it('opens, saves by confirmed revision and reopens exact bytes with special filenames', async () => {
    const path = '/unicode é #? +\"\nfile.ts'; await writeFile(join(workspace.root, path.slice(1)), 'old\r\n');
    const first = await codeRead(workspace, path);
    const bytes = Buffer.from('new\r\n☃\n');
    const saved = await codeWrite(workspace, { path, revision: first.revision, content: bytes.toString('base64') }, async () => undefined);
    expect(saved.revision).not.toBe(first.revision);
    expect((await codeRead(workspace, path)).revision).toBe(saved.revision);
    expect(await readFile(join(workspace.root, path.slice(1)))).toEqual(bytes);
    // Read-back confirmation of an uncertain duplicate never rewrites the file.
    expect(await codeWrite(workspace, { path, revision: first.revision, content: bytes.toString('base64') }, async () => undefined)).toEqual(saved);
  });
  it('rejects conflicts and lifecycle changes without overwriting either version', async () => {
    const path = '/file'; await writeFile(join(workspace.root, 'file'), 'original');
    const first = await codeRead(workspace, path); await writeFile(join(workspace.root, 'file'), 'external');
    await expect(codeWrite(workspace, { path, revision: first.revision, content: Buffer.from('mine').toString('base64') }, async () => undefined)).rejects.toThrow('File changed');
    const current = await codeRead(workspace, path);
    await expect(codeWrite(workspace, { path, revision: current.revision, content: Buffer.from('mine').toString('base64') }, async () => { throw new Error('Task reassigned'); })).rejects.toThrow('Task reassigned');
    expect(await readFile(join(workspace.root, 'file'), 'utf8')).toBe('external');
    expect((await codeDirectory(workspace, '/')).entries.map(e => e.name)).toEqual(['file']);
  });
  it.each(['/../outside', '/sub/../../outside', '/.git/config', '//outside', '/file\0'])('rejects unsafe path %s', async path => {
    await expect(confinedPath(workspace, path, true)).rejects.toThrow();
  });
  it('rejects both file and directory symlink escapes and nonregular files', async () => {
    await writeFile(join(directory, 'secret'), 'private');
    await symlink(directory, join(workspace.root, 'escape'));
    await symlink(join(directory, 'secret'), join(workspace.root, 'secret'));
    await expect(codeRead(workspace, '/escape/secret')).rejects.toThrow();
    await expect(codeStat(workspace, '/secret')).rejects.toThrow();
    await expect(codeWrite(workspace, { path: '/escape/new', revision: null, content: '' }, async () => undefined)).rejects.toThrow();
  });
  it('pages a directory without dropping or duplicating entries and hides Git metadata', async () => {
    await Promise.all(Array.from({ length: 525 }, (_, i) => writeFile(join(workspace.root, `file-${String(i).padStart(4, '0')}`), '')));
    await mkdir(join(workspace.root, '.git'));
    const names: string[] = []; let after = '';
    for (;;) { const page = await codeDirectory(workspace, '/', after); expect(page.entries.length).toBeLessThanOrEqual(200); names.push(...page.entries.map(e => e.name)); if (!page.next) break; after = page.next; }
    expect(names).toHaveLength(525); expect(new Set(names).size).toBe(525); expect(names).toEqual([...names].sort());
  });
  it('reports read-only files and never replaces them through an atomic rename', async () => {
    const path = '/readonly'; await writeFile(join(workspace.root, 'readonly'), 'original');
    const original = await codeRead(workspace, path); await chmod(join(workspace.root, 'readonly'), 0o444);
    expect((await codeStat(workspace, path)).permissions).toBe(1);
    await expect(codeWrite(workspace, { path, revision: original.revision, content: Buffer.from('changed').toString('base64') }, async () => undefined)).rejects.toThrow('read-only');
    expect(await readFile(join(workspace.root, 'readonly'), 'utf8')).toBe('original');
  });
  it('preserves an existing file mode when atomically replacing its contents', async () => {
    if (process.platform === 'win32') return;
    const target = join(workspace.root, 'shared-script');
    await writeFile(target, 'original'); await chmod(target, 0o777);
    const original = await codeRead(workspace, '/shared-script');
    await codeWrite(workspace, { path: '/shared-script', revision: original.revision, content: Buffer.from('changed').toString('base64') }, async () => undefined);
    expect((await lstat(target)).mode & 0o777).toBe(0o777);
  });
  it('does not leave an empty destination when publishing a new file fails', async () => {
    const filesystem = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    const failure = Object.assign(new Error('Publication failed'), { code: 'EIO' });
    const moving = jest.spyOn(filesystem, 'rename').mockRejectedValue(failure);
    const linking = jest.spyOn(filesystem, 'link').mockRejectedValue(failure);
    try {
      await expect(codeWrite(workspace, { path: '/new', revision: null, content: Buffer.from('created').toString('base64') }, async () => undefined)).rejects.toThrow('Publication failed');
      expect((await codeDirectory(workspace, '/')).entries).toEqual([]);
      await expect(lstat(join(workspace.root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { moving.mockRestore(); linking.mockRestore(); }
  });
  it('does not overwrite another creator at the new-file publication boundary', async () => {
    const filesystem = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    const move = filesystem.rename, publish = filesystem.link;
    const moving = jest.spyOn(filesystem, 'rename').mockImplementation(async (source, target) => { await writeFile(target, 'external'); await move(source, target); });
    const linking = jest.spyOn(filesystem, 'link').mockImplementation(async (source, target) => { await writeFile(target, 'external'); await publish(source, target); });
    try {
      await expect(codeWrite(workspace, { path: '/new', revision: null, content: Buffer.from('mine').toString('base64') }, async () => undefined)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(join(workspace.root, 'new'), 'utf8')).toBe('external');
      expect((await codeDirectory(workspace, '/')).entries.map(entry => entry.name)).toEqual(['new']);
    } finally { moving.mockRestore(); linking.mockRestore(); }
  });
  it('creates, renames and deletes files with conflict checks', async () => {
    await codeMkdir(workspace, '/folder');
    await codeWrite(workspace, { path: '/folder/new', revision: null, content: Buffer.from('created').toString('base64') }, async () => undefined);
    await codeRename(workspace, { path: '/folder/new', target: '/folder/renamed' });
    await writeFile(join(workspace.root, 'existing'), 'other');
    await expect(codeRename(workspace, { path: '/folder/renamed', target: '/existing' })).rejects.toThrow('exists');
    await expect(codeDelete(workspace, { path: '/folder/renamed', revision: 'b'.repeat(64) })).rejects.toThrow('changed');
    const current = await codeRead(workspace, '/folder/renamed'); await codeDelete(workspace, { path: '/folder/renamed', revision: current.revision });
    expect((await codeDirectory(workspace, '/folder')).entries).toEqual([]);
  });
});
