import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeTransfers, TRANSFER_CHUNK } from './code-transfers.service.js';
import type { CodeWorkspace } from './code-authorization.service.js';
import { codeDirectory } from './code-files.js';

describe('task file transfers', () => {
  let root: string, workspace: CodeWorkspace, transfers: CodeTransfers;
  const signal = new AbortController().signal;
  const current = async () => undefined;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'code-transfer-test-')));
    workspace = { taskId: 1, identity: 'a'.repeat(64), storageIdentity: 'a'.repeat(64), root: join(root, 'task'), name: 'Task', branch: 'task' };
    await mkdir(workspace.root); transfers = new CodeTransfers();
  });
  afterEach(async () => { await transfers.onModuleDestroy(); await rm(root, { recursive: true, force: true }); });
  async function upload(path: string, bytes: Buffer, revision: string | null = null) {
    const { id } = await transfers.begin(workspace, { path, size: bytes.length, revision });
    for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK) await transfers.append(workspace, { id, offset, content: bytes.subarray(offset, offset + TRANSFER_CHUNK).toString('base64') }, signal);
    return id;
  }
  it('transfers binary files larger than the editor limit with bounded chunks and no partial destination', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 7); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const id = await upload('/binary é.bin', bytes);
    expect((await transfers.stat(workspace, '/binary é.bin')).exists).toBe(false);
    expect((await codeDirectory(workspace, '/')).entries).toEqual([]);
    await transfers.commit(workspace, { id }, current, signal);
    const info = await transfers.stat(workspace, '/binary é.bin');
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const chunk = await transfers.read(workspace, { path: '/binary é.bin', offset, revision: info.revision }, signal);
      const content = Buffer.from(chunk.content, 'base64'); expect(content.length).toBeLessThanOrEqual(TRANSFER_CHUNK); chunks.push(content); offset = chunk.offset;
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
  });
  it('publishes empty files and retains existing permissions on confirmed replacement', async () => {
    await transfers.commit(workspace, { id: await upload('/empty', Buffer.alloc(0)) }, current, signal);
    expect(await readFile(join(workspace.root, 'empty'))).toHaveLength(0);
    await writeFile(join(workspace.root, 'shared'), 'old'); await chmod(join(workspace.root, 'shared'), 0o755);
    const info = await transfers.stat(workspace, '/shared');
    await transfers.commit(workspace, { id: await upload('/shared', Buffer.from('new'), info.revision) }, current, signal);
    expect(await readFile(join(workspace.root, 'shared'), 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect((await lstat(join(workspace.root, 'shared'))).mode & 0o777).toBe(0o755);
  });
  it('rejects replacement races, stale download revisions and read-only files', async () => {
    await writeFile(join(workspace.root, 'file'), 'old');
    const info = await transfers.stat(workspace, '/file');
    const id = await upload('/file', Buffer.from('replacement'), info.revision);
    await writeFile(join(workspace.root, 'file'), 'changed');
    await expect(transfers.commit(workspace, { id }, current, signal)).rejects.toThrow('File changed');
    await expect(transfers.read(workspace, { path: '/file', offset: 0, revision: info.revision }, signal)).rejects.toThrow('File changed');
    const latest = await transfers.stat(workspace, '/file');
    const next = await upload('/file', Buffer.from('new'), latest.revision);
    await chmod(join(workspace.root, 'file'), 0o444);
    await expect(transfers.commit(workspace, { id: next }, current, signal)).rejects.toThrow();
    expect(await readFile(join(workspace.root, 'file'), 'utf8')).toBe('changed');
  });
  it('blocks cross-task staging access, out-of-order/oversized chunks and incomplete commits', async () => {
    const { id } = await transfers.begin(workspace, { path: '/file', size: 4, revision: null });
    await expect(transfers.append({ ...workspace, identity: 'b'.repeat(64) }, { id, offset: 0, content: 'YQ==' }, signal)).rejects.toThrow();
    await expect(transfers.append(workspace, { id, offset: 2, content: 'YQ==' }, signal)).rejects.toThrow('sequence');
    await expect(transfers.append(workspace, { id, offset: 0, content: Buffer.alloc(TRANSFER_CHUNK + 1).toString('base64') }, signal)).rejects.toThrow();
    await expect(transfers.commit(workspace, { id }, current, signal)).rejects.toThrow('incomplete');
    await transfers.abort(workspace, { id });
    await expect(transfers.commit(workspace, { id }, current, signal)).rejects.toThrow('expired');
  });
  it('rejects traversal, Git metadata and symlinks, and cancels without publishing bytes', async () => {
    await writeFile(join(root, 'secret'), 'outside'); await symlink(root, join(workspace.root, 'escape'));
    for (const path of ['/../secret', '/.git/config', '/escape/secret']) await expect(transfers.begin(workspace, { path, size: 0, revision: null })).rejects.toThrow();
    const id = await upload('/file', Buffer.from('bytes'));
    const cancellation = new AbortController(); cancellation.abort();
    await expect(transfers.commit(workspace, { id }, current, cancellation.signal)).rejects.toThrow();
    expect((await transfers.stat(workspace, '/file')).exists).toBe(false);
    expect((await codeDirectory(workspace, '/')).entries).toEqual([]);
  });
  it('discards staging after task invalidation and rejects lifecycle changes at publication', async () => {
    const id = await upload('/file', Buffer.from('bytes'));
    await expect(transfers.commit(workspace, { id }, async () => { throw new Error('Task changed'); }, signal)).rejects.toThrow('Task changed');
    expect((await transfers.stat(workspace, '/file')).exists).toBe(false);
    const next = await upload('/file', Buffer.from('bytes')); await transfers.release(workspace.identity);
    await expect(transfers.commit(workspace, { id: next }, current, signal)).rejects.toThrow('expired');
    const during = await upload('/file', Buffer.from('bytes'));
    await expect(transfers.commit(workspace, { id: during }, () => transfers.release(workspace.identity), signal)).rejects.toThrow('cancelled');
    expect((await transfers.stat(workspace, '/file')).exists).toBe(false);
  });
});
