import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCodeLink, resolveCodeLink } from './code-links.js';
import type { CodeWorkspace } from './code-authorization.service.js';

describe('Code chat links', () => {
  let directory: string, workspace: CodeWorkspace, external: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'code-links-')));
    workspace = { root: join(directory, 'task'), taskId: 1, identity: 'g', storageIdentity: 's', name: 'Task', branch: 'task' };
    external = join(directory, 'notes');
    await mkdir(join(workspace.root, 'src'), { recursive: true });
    await mkdir(external);
    await writeFile(join(workspace.root, 'src', 'hello #.ts'), 'one\ntwo\nthree');
    await writeFile(join(external, 'report.md'), '# Report');
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('maps relative, absolute and file URL targets to the task with line and column positions', async () => {
    const file = join(workspace.root, 'src', 'hello #.ts');
    await expect(resolveCodeLink(workspace, './src/hello%20%23.ts:2:3')).resolves.toMatchObject({
      kind: 'workspace', path: '/src/hello #.ts', type: 1, line: 2, column: 3,
    });
    await expect(resolveCodeLink(workspace, pathToFileURL(file).href + '#L3C2')).resolves.toMatchObject({
      kind: 'workspace', path: '/src/hello #.ts', type: 1, line: 3, column: 2,
    });
    await expect(resolveCodeLink(workspace, join(workspace.root, 'src'))).resolves.toMatchObject({ kind: 'workspace', path: '/src', type: 2 });
    await expect(resolveCodeLink(workspace, '.')).resolves.toMatchObject({ kind: 'workspace', path: '/', type: 2 });
  });

  it('confines outside folder reads to the resolved root and rejects root replacement', async () => {
    const link = await resolveCodeLink(workspace, '../notes/');
    expect(link).toMatchObject({ kind: 'external', type: 2, name: 'notes' });
    const grant = { root: link.path, fingerprint: link.fingerprint };
    const signal = new AbortController().signal;
    await expect(readCodeLink('link-directory', { ...grant, path: '/' }, signal)).resolves.toEqual({
      entries: [{ name: 'report.md', type: 1 }], next: null,
    });
    await expect(readCodeLink('link-read', { ...grant, path: '/report.md' }, signal)).resolves.toMatchObject({
      content: Buffer.from('# Report').toString('base64'),
    });
    await expect(readCodeLink('link-stat', { ...grant, path: '/../task' }, signal)).rejects.toThrow();
    await rename(external, join(directory, 'old-notes'));
    await mkdir(external);
    await expect(readCodeLink('link-stat', { ...grant, path: '/' }, signal)).rejects.toThrow('changed');
  });

  it('grants only the requested file and rejects symlinks and nonlocal URL authorities', async () => {
    const link = await resolveCodeLink(workspace, pathToFileURL(join(external, 'report.md')).href);
    expect(link).toMatchObject({ kind: 'external', type: 1, name: 'report.md' });
    const grant = { root: link.path, fingerprint: link.fingerprint }, signal = new AbortController().signal;
    await expect(readCodeLink('link-read', { ...grant, path: '/report.md' }, signal)).rejects.toThrow();
    await expect(resolveCodeLink(workspace, 'file://example.test/etc/passwd')).rejects.toThrow('Invalid file link');
    if (process.platform === 'win32') return;
    await symlink(external, join(workspace.root, 'escape'));
    await expect(resolveCodeLink(workspace, 'escape/report.md')).rejects.toThrow('Symbolic links');
    const folder = await resolveCodeLink(workspace, external);
    await symlink(workspace.root, join(external, 'escape'));
    await expect(readCodeLink('link-stat', { root: folder.path, fingerprint: folder.fingerprint, path: '/escape/src' }, signal)).rejects.toThrow('Symbolic links');
  });
});
