import * as assert from 'assert';
import { FileSystemError, FileType, Uri } from 'vscode';
import { BackendClient } from '../../src/backendClient';

type FetchCall = {
  input: string | URL;
  init?: RequestInit;
};

suite('BackendClient', () => {
  const originalFetch = globalThis.fetch;
  const baseUrl = 'http://localhost:3000/api/worktrees';
  const worktreePath = '/tmp/test-worktree';
  let fetchCalls: FetchCall[];

  setup(() => {
    fetchCalls = [];
  });

  teardown(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: {
    ok: boolean;
    status: number;
    json?: unknown;
  }) {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json,
      } as Response;
    }) as typeof fetch;
  }

  function getLastCall(): FetchCall {
    assert.strictEqual(fetchCalls.length, 1, 'Expected exactly one fetch call');
    return fetchCalls[0];
  }

  test('stat maps backend JSON to FileStat', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: { type: 'file', ctime: 1, mtime: 2, size: 3 },
    });
    const client = new BackendClient(baseUrl);

    const stat = await client.stat(worktreePath, 'src/test.txt');

    assert.deepStrictEqual(stat, {
      type: FileType.File,
      ctime: 1,
      mtime: 2,
      size: 3,
    });
    assert.strictEqual(
      String(getLastCall().input),
      `${baseUrl}/${encodeURIComponent(worktreePath)}/stat?path=src%2Ftest.txt`,
    );
  });

  test('readFile returns Uint8Array from backend content', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: { content: 'test content' },
    });
    const client = new BackendClient(baseUrl);

    const content = await client.readFile(worktreePath, 'test.txt');

    assert.ok(content instanceof Uint8Array);
    assert.strictEqual(new TextDecoder().decode(content), 'test content');
  });

  test('readDirectory maps backend entries to tuples', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: [
        { label: 'test.txt', data: { type: 'file' } },
        { label: 'subdir', data: { type: 'directory' } },
      ],
    });
    const client = new BackendClient(baseUrl);

    const entries = await client.readDirectory(worktreePath, '');

    assert.deepStrictEqual(entries, [
      ['test.txt', FileType.File],
      ['subdir', FileType.Directory],
    ]);
  });

  test('404 error mapped to FileNotFound', async () => {
    stubFetch({ ok: false, status: 404 });
    const client = new BackendClient(baseUrl);

    await assert.rejects(
      () => client.stat(worktreePath, 'missing.txt'),
      (error: unknown) => {
        const fileError = error as FileSystemError;
        return (
          fileError.code === 'FileNotFound' ||
          fileError.code === 'EntryNotFound' ||
          fileError.name?.includes('NotFound')
        );
      },
    );
  });

  test('writeFile persists content with PUT request', async () => {
    stubFetch({ ok: true, status: 200, json: { success: true } });
    const client = new BackendClient(baseUrl);

    await client.writeFile(worktreePath, 'newfile.txt', new TextEncoder().encode('new file content'));

    const call = getLastCall();
    assert.strictEqual(String(call.input), `${baseUrl}/${encodeURIComponent(worktreePath)}/file?path=newfile.txt`);
    assert.strictEqual(call.init?.method, 'PUT');
    assert.deepStrictEqual(call.init?.headers, { 'Content-Type': 'application/json' });
    assert.strictEqual(call.init?.body, JSON.stringify({ content: 'new file content' }));
  });

  test('writeFile rejects path traversal', async () => {
    const client = new BackendClient(baseUrl);

    await assert.rejects(
      () => client.writeFile(worktreePath, '../outside.txt', new TextEncoder().encode('malicious')),
      (error: unknown) => {
        const fileError = error as FileSystemError;
        return fileError.code === 'NoPermissions' || fileError.name?.includes('NoPermissions');
      },
    );

    assert.strictEqual(fetchCalls.length, 0, 'Path traversal should not trigger fetch');
  });

  test('createDirectory uses POST directory endpoint', async () => {
    stubFetch({ ok: true, status: 200, json: { success: true } });
    const client = new BackendClient(baseUrl);

    await client.createDirectory(worktreePath, 'src/new folder');

    const call = getLastCall();
    assert.strictEqual(
      String(call.input),
      `${baseUrl}/${encodeURIComponent(worktreePath)}/directories/src/new%20folder`,
    );
    assert.strictEqual(call.init?.method, 'POST');
  });

  test('rename uses PATCH files endpoint with body', async () => {
    stubFetch({ ok: true, status: 200, json: { success: true } });
    const client = new BackendClient(baseUrl);

    await client.rename(worktreePath, 'src/old.txt', 'src/new.txt', true);

    const call = getLastCall();
    assert.strictEqual(
      String(call.input),
      `${baseUrl}/${encodeURIComponent(worktreePath)}/files/src/old.txt`,
    );
    assert.strictEqual(call.init?.method, 'PATCH');
    assert.deepStrictEqual(call.init?.headers, { 'Content-Type': 'application/json' });
    assert.strictEqual(call.init?.body, JSON.stringify({ newPath: 'src/new.txt', overwrite: true }));
  });

  test('deleteEntry uses DELETE endpoint with recursive query', async () => {
    stubFetch({ ok: true, status: 200, json: { success: true } });
    const client = new BackendClient(baseUrl);

    await client.deleteEntry(worktreePath, 'src/old-dir', true);

    const call = getLastCall();
    assert.strictEqual(
      String(call.input),
      `${baseUrl}/${encodeURIComponent(worktreePath)}/files/src/old-dir?recursive=true`,
    );
    assert.strictEqual(call.init?.method, 'DELETE');
  });

  test('mutation methods reject path traversal before fetch', async () => {
    const client = new BackendClient(baseUrl);

    await assert.rejects(() => client.createDirectory(worktreePath, '../outside'));
    await assert.rejects(() => client.rename(worktreePath, '../old', 'new.txt', false));
    await assert.rejects(() => client.rename(worktreePath, 'old.txt', '../new', false));
    await assert.rejects(() => client.deleteEntry(worktreePath, '../outside', false));

    assert.strictEqual(fetchCalls.length, 0, 'Traversal checks should prevent network calls');
  });

  test('mutation methods map backend errors through mapHttpError', async () => {
    stubFetch({ ok: false, status: 403 });
    const client = new BackendClient(baseUrl);
    const uri = Uri.from({
      scheme: 'workspace-vfs',
      authority: encodeURIComponent(worktreePath),
      path: '/src/protected',
    });

    await assert.rejects(
      () => client.createDirectory(worktreePath, 'src/protected'),
      (error: unknown) => {
        const fileError = error as FileSystemError;
        return (
          (fileError.code === 'NoPermissions' || fileError.name?.includes('NoPermissions')) &&
          fileError.message.includes(uri.toString())
        );
      },
    );
  });
});
