import * as assert from 'assert';
import {
  FileChangeEvent,
  FileChangeType,
  FileSystemError,
  FileType,
  Uri,
} from 'vscode';
import { BackendClient } from '../../src/backendClient';
import { WorkspaceVfsProvider } from '../../src/fileSystemProvider';

type FileEntry = {
  content: Uint8Array;
  ctime: number;
  mtime: number;
};

type DirectoryMap = Map<string, Set<string>>;

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function createStubBackend() {
  const now = Date.now();
  const files = new Map<string, FileEntry>([
    [
      'test.txt',
      {
        content: new TextEncoder().encode('test content'),
        ctime: now - 1000,
        mtime: now,
      },
    ],
    [
      'subdir/nested.txt',
      {
        content: new TextEncoder().encode('nested content'),
        ctime: now - 2000,
        mtime: now - 500,
      },
    ],
  ]);
  const directories: DirectoryMap = new Map([
    ['', new Set(['test.txt', 'subdir'])],
    ['subdir', new Set(['nested.txt'])],
  ]);
  const calls = {
    createDirectory: [] as Array<{ worktreePath: string; path: string }>,
    deleteEntry: [] as Array<{ worktreePath: string; path: string; recursive: boolean }>,
    rename: [] as Array<{ worktreePath: string; oldPath: string; newPath: string; overwrite: boolean }>,
    writeFile: [] as Array<{ worktreePath: string; path: string; content: string }>,
  };

  function ensureDirectory(path: string) {
    const normalized = normalizePath(path);
    if (!directories.has(normalized)) {
      directories.set(normalized, new Set());
      const parent = dirname(normalized);
      if (normalized) {
        directories.get(parent)?.add(basename(normalized));
      }
    }
  }

  function removeDirectoryRecursively(path: string) {
    const normalized = normalizePath(path);
    for (const key of Array.from(directories.keys())) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        directories.delete(key);
      }
    }
    for (const key of Array.from(files.keys())) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        files.delete(key);
      }
    }
    directories.get(dirname(normalized))?.delete(basename(normalized));
  }

  function removeFile(path: string) {
    const normalized = normalizePath(path);
    files.delete(normalized);
    directories.get(dirname(normalized))?.delete(basename(normalized));
  }

  const backend = new BackendClient();

  (backend as any).stat = async (_worktreePath: string, path: string) => {
    const normalized = normalizePath(path);

    if (files.has(normalized)) {
      const entry = files.get(normalized)!;
      return {
        type: FileType.File,
        ctime: entry.ctime,
        mtime: entry.mtime,
        size: entry.content.length,
      };
    }

    if (directories.has(normalized)) {
      return {
        type: FileType.Directory,
        ctime: now - 5000,
        mtime: now - 1000,
        size: 0,
      };
    }

    throw FileSystemError.FileNotFound(Uri.parse(`workspace-vfs://test-worktree/${normalized}`));
  };

  (backend as any).readFile = async (_worktreePath: string, path: string) => {
    const entry = files.get(normalizePath(path));
    if (!entry) {
      throw FileSystemError.FileNotFound(Uri.parse(`workspace-vfs://test-worktree/${normalizePath(path)}`));
    }
    return entry.content;
  };

  (backend as any).readDirectory = async (_worktreePath: string, path: string) => {
    const normalized = normalizePath(path);
    const directory = directories.get(normalized);
    if (!directory) {
      throw FileSystemError.FileNotFound(Uri.parse(`workspace-vfs://test-worktree/${normalized}`));
    }

    return Array.from(directory)
      .sort()
      .map((name) => {
        const childPath = normalizePath(normalized ? `${normalized}/${name}` : name);
        return [name, files.has(childPath) ? FileType.File : FileType.Directory] as [string, FileType];
      });
  };

  (backend as any).writeFile = async (worktreePath: string, path: string, content: Uint8Array) => {
    const normalized = normalizePath(path);
    if (normalized.includes('..')) {
      throw FileSystemError.NoPermissions(Uri.parse(`workspace-vfs://test-worktree/${normalized}`));
    }

    ensureDirectory(dirname(normalized));
    directories.get(dirname(normalized))?.add(basename(normalized));
    files.set(normalized, {
      content,
      ctime: now,
      mtime: now,
    });
    calls.writeFile.push({
      worktreePath,
      path: normalized,
      content: new TextDecoder().decode(content),
    });
  };

  (backend as any).createDirectory = async (worktreePath: string, path: string) => {
    const normalized = normalizePath(path);
    ensureDirectory(normalized);
    calls.createDirectory.push({ worktreePath, path: normalized });
  };

  (backend as any).deleteEntry = async (worktreePath: string, path: string, recursive: boolean) => {
    const normalized = normalizePath(path);
    if (directories.has(normalized)) {
      const hasChildren = (directories.get(normalized)?.size ?? 0) > 0;
      if (hasChildren && !recursive) {
        throw FileSystemError.NoPermissions(Uri.parse(`workspace-vfs://test-worktree/${normalized}`));
      }
      removeDirectoryRecursively(normalized);
    } else if (files.has(normalized)) {
      removeFile(normalized);
    } else {
      throw FileSystemError.FileNotFound(Uri.parse(`workspace-vfs://test-worktree/${normalized}`));
    }
    calls.deleteEntry.push({ worktreePath, path: normalized, recursive });
  };

  (backend as any).rename = async (
    worktreePath: string,
    oldPath: string,
    newPath: string,
    overwrite: boolean,
  ) => {
    const oldNormalized = normalizePath(oldPath);
    const newNormalized = normalizePath(newPath);

    if (files.has(oldNormalized)) {
      const entry = files.get(oldNormalized)!;
      files.delete(oldNormalized);
      ensureDirectory(dirname(newNormalized));
      directories.get(dirname(oldNormalized))?.delete(basename(oldNormalized));
      directories.get(dirname(newNormalized))?.add(basename(newNormalized));
      files.set(newNormalized, entry);
    } else if (directories.has(oldNormalized)) {
      const childDirs = Array.from(directories.entries())
        .filter(([key]) => key === oldNormalized || key.startsWith(`${oldNormalized}/`));
      const childFiles = Array.from(files.entries())
        .filter(([key]) => key === oldNormalized || key.startsWith(`${oldNormalized}/`));

      removeDirectoryRecursively(oldNormalized);
      ensureDirectory(newNormalized);

      for (const [key, value] of childDirs) {
        if (key === oldNormalized) {
          continue;
        }
        directories.set(key.replace(oldNormalized, newNormalized), new Set(value));
      }
      for (const [key, value] of childFiles) {
        files.set(key.replace(oldNormalized, newNormalized), value);
      }
    } else {
      throw FileSystemError.FileNotFound(Uri.parse(`workspace-vfs://test-worktree/${oldNormalized}`));
    }

    calls.rename.push({
      worktreePath,
      oldPath: oldNormalized,
      newPath: newNormalized,
      overwrite,
    });
  };

  return { backend, calls };
}

suite('FileSystemProvider', () => {
  const worktreePath = '/tmp/test-worktree';
  let provider: WorkspaceVfsProvider;
  let backend: BackendClient;
  let calls: ReturnType<typeof createStubBackend>['calls'];

  setup(() => {
    const stub = createStubBackend();
    backend = stub.backend;
    calls = stub.calls;
    provider = new WorkspaceVfsProvider(backend, worktreePath);
  });

  teardown(() => {
    provider.dispose();
  });

  test('stat returns file metadata', async () => {
    const stat = await provider.stat(
      Uri.from({ scheme: 'workspace-vfs', authority: encodeURIComponent(worktreePath), path: '/test.txt' }),
    );

    assert.strictEqual(stat.type, FileType.File);
    assert.ok(stat.size > 0);
    assert.ok(stat.mtime > 0);
    assert.ok(stat.ctime > 0);
  });

  test('readFile returns content', async () => {
    const content = await provider.readFile(
      Uri.from({ scheme: 'workspace-vfs', authority: encodeURIComponent(worktreePath), path: '/test.txt' }),
    );

    assert.strictEqual(new TextDecoder().decode(content), 'test content');
  });

  test('readDirectory returns entries', async () => {
    const entries = await provider.readDirectory(
      Uri.from({ scheme: 'workspace-vfs', authority: encodeURIComponent(worktreePath), path: '/' }),
    );

    assert.ok(entries.some(([name, type]) => name === 'test.txt' && type === FileType.File));
    assert.ok(entries.some(([name, type]) => name === 'subdir' && type === FileType.Directory));
  });

  test('createDirectory succeeds and emits Created event', async () => {
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/docs/guides',
    });
    const changePromise = new Promise<FileChangeEvent[]>((resolve) => provider.onDidChangeFile(resolve));

    await provider.createDirectory(uri);

    assert.deepStrictEqual(calls.createDirectory, [{ worktreePath, path: 'docs/guides' }]);
    const changes = await changePromise;
    assert.deepStrictEqual(changes, [{ type: FileChangeType.Created, uri }]);
  });

  test('delete file succeeds and emits Deleted event', async () => {
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/test.txt',
    });
    const changePromise = new Promise<FileChangeEvent[]>((resolve) => provider.onDidChangeFile(resolve));

    await provider.delete(uri, { recursive: false });

    assert.deepStrictEqual(calls.deleteEntry, [{ worktreePath, path: 'test.txt', recursive: false }]);
    const changes = await changePromise;
    assert.deepStrictEqual(changes, [{ type: FileChangeType.Deleted, uri }]);
  });

  test('delete non-empty directory requires recursive true', async () => {
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/subdir',
    });

    await assert.rejects(
      () => provider.delete(uri, { recursive: false }),
      (error: unknown) => {
        const fileError = error as FileSystemError;
        return fileError.code === 'NoPermissions' || fileError.name?.includes('NoPermissions');
      },
    );

    assert.strictEqual(calls.deleteEntry.length, 0);
  });

  test('rename succeeds within same worktree and emits delete/create events in order', async () => {
    const oldUri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/test.txt',
    });
    const newUri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/renamed.txt',
    });
    const changePromise = new Promise<FileChangeEvent[]>((resolve) => provider.onDidChangeFile(resolve));

    await provider.rename(oldUri, newUri, { overwrite: true });

    assert.deepStrictEqual(calls.rename, [
      {
        worktreePath,
        oldPath: 'test.txt',
        newPath: 'renamed.txt',
        overwrite: true,
      },
    ]);
    const changes = await changePromise;
    assert.deepStrictEqual(changes, [
      { type: FileChangeType.Deleted, uri: oldUri },
      { type: FileChangeType.Created, uri: newUri },
    ]);
  });

  test('rename rejects cross-worktree authority changes', async () => {
    const oldUri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/test.txt',
    });
    const newUri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent('/tmp/other-worktree'),
      path: '/test.txt',
    });

    await assert.rejects(
      () => provider.rename(oldUri, newUri, { overwrite: false }),
      (error: unknown) => {
        const fileError = error as FileSystemError;
        return fileError.code === 'NoPermissions' || fileError.name?.includes('NoPermissions');
      },
    );
  });

  test('writeFile create regression remains green', async () => {
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/new.txt',
    });
    const content = new TextEncoder().encode('new content');
    const changePromise = new Promise<FileChangeEvent[]>((resolve) => provider.onDidChangeFile(resolve));

    await provider.writeFile(uri, content, { create: true, overwrite: false });

    assert.deepStrictEqual(calls.writeFile, [{ worktreePath, path: 'new.txt', content: 'new content' }]);
    assert.deepStrictEqual(await provider.readFile(uri), content);
    const changes = await changePromise;
    assert.deepStrictEqual(changes, [{ type: FileChangeType.Changed, uri }]);
  });

  test('writeFile overwrite regression remains green', async () => {
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/test.txt',
    });

    await provider.writeFile(uri, new TextEncoder().encode('updated'), {
      create: false,
      overwrite: true,
    });

    assert.strictEqual(calls.writeFile[0]?.content, 'updated');
    assert.strictEqual(new TextDecoder().decode(await provider.readFile(uri)), 'updated');
  });

  test('fireFileChange still propagates external refresh events', async () => {
    const expectedUri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/external.txt',
    });
    const changePromise = new Promise<FileChangeEvent[]>((resolve) => provider.onDidChangeFile(resolve));

    provider.fireFileChange([{ type: FileChangeType.Changed, uri: expectedUri }]);

    assert.deepStrictEqual(await changePromise, [{ type: FileChangeType.Changed, uri: expectedUri }]);
  });
});
