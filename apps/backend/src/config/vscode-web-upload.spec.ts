import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildVSCodeUploadProgressScript } from './vscode-web-upload.js';
import { renderVSCodeWorkbenchHtml } from './vscode-web-launcher.js';

describe('VS Code upload progress', () => {
  let requests: FakeRequest[];
  let prototype: Record<string, jest.Mock>;
  const workspace =
    'workspace-vfs://elevenex/?worktreePath=%2Ftmp%2FCase%25Dir&taskId=42';
  const resource = {
    scheme: 'workspace-vfs',
    query: 'worktreePath=%2Ftmp%2FCase%25Dir',
    path: '/folder/archive %.gz',
  };

  class FakeRequest {
    upload = {
      onprogress: null as ((event: { loaded: number }) => void) | null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 200;
    open = jest.fn();
    setRequestHeader = jest.fn();
    send = jest.fn();
    abort = jest.fn(() => this.onabort?.());
    constructor() {
      requests.push(this);
    }
  }

  beforeEach(() => {
    requests = [];
    prototype = { j: jest.fn(), k: jest.fn() };
    // Execute the exact serialized code served to the browser, including AMD
    // wiring, rather than testing only the server-side function.
    runInNewContext(
      buildVSCodeUploadProgressScript().replace(/<\/?script>/g, ''),
      {
        require: (
          dependencies: string[],
          callback: (module: unknown) => void,
        ) => {
          expect(dependencies).toEqual([
            'vs/workbench/contrib/files/browser/fileImportExport',
          ]);
          callback({ $1rb: { prototype } });
        },
        window: {
          location: {
            origin: 'http://localhost:11111',
            search: '?workspace=' + encodeURIComponent(workspace),
          },
        },
        URL,
        URLSearchParams,
        XMLHttpRequest: FakeRequest,
      },
    );
  });

  it.each(['j', 'k'])(
    'reports transferred bytes for writer %s and waits for server confirmation',
    async (method) => {
      const file = { size: 10_000_000 };
      const report = jest.fn();
      let completed = false;
      const pending = prototype[method](resource, file, report).then(() => {
        completed = true;
      });
      const xhr = requests[0];
      expect(xhr.send).toHaveBeenCalledWith(file);
      expect(report).not.toHaveBeenCalled();
      expect(xhr.open).toHaveBeenCalledWith(
        'PUT',
        '/api/worktrees/%2Ftmp%2FCase%25Dir/raw?path=folder%2Farchive+%25.gz',
      );
      expect(xhr.setRequestHeader).toHaveBeenCalledWith(
        'x-elevenex-task-id',
        '42',
      );

      xhr.upload.onprogress?.({ loaded: 2_000_000 });
      expect(report).toHaveBeenLastCalledWith(file.size, 2_000_000);
      xhr.upload.onprogress?.({ loaded: 5_000_000 });
      expect(report).toHaveBeenLastCalledWith(file.size, 3_000_000);
      xhr.upload.onprogress?.({ loaded: file.size });
      expect(report).toHaveBeenLastCalledWith(file.size, 4_999_999);
      await Promise.resolve();
      expect(completed).toBe(false);
      xhr.onload?.();
      await pending;
      expect(report).toHaveBeenLastCalledWith(file.size, 1);
      expect(xhr.upload.onprogress).toBeNull();
    },
  );

  it('aborts a cancelled transfer and releases its listener without reporting completion', async () => {
    let cancel: () => void = () => undefined;
    const dispose = jest.fn();
    const report = jest.fn();
    const pending = prototype.j(resource, { size: 100 }, report, {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        cancel = listener;
        return { dispose };
      },
    });
    cancel();
    await pending;
    expect(requests[0].abort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it.each([403, 500])(
    'rejects HTTP %s without reporting successful completion',
    async (status) => {
      const report = jest.fn();
      const pending = prototype.j(resource, { size: 100 }, report);
      requests[0].status = status;
      requests[0].onload?.();
      await expect(pending).rejects.toThrow('HTTP ' + status);
      expect(report).not.toHaveBeenCalled();
    },
  );

  it('rejects a disconnected transfer', async () => {
    const pending = prototype.j(resource, { size: 100 }, jest.fn());
    requests[0].onerror?.();
    await expect(pending).rejects.toThrow('network error');
  });

  it('passes other filesystem schemes through to the original writer', async () => {
    await prototype.j(
      { ...resource, scheme: 'file' },
      { size: 100 },
      jest.fn(),
    );
    expect(requests).toHaveLength(0);
  });

  it('installs before the workbench entrypoint, after the main bundle', () => {
    const html = renderVSCodeWorkbenchHtml(
      '<head></head><script src="/vscode-static/out/vs/workbench/workbench.web.main.js"></script><script src="/vscode-static/out/vs/code/browser/workbench/workbench.js"></script>',
    );
    const adapter = html.indexOf(
      "require(['vs/workbench/contrib/files/browser/fileImportExport']",
    );
    expect(adapter).toBeGreaterThan(html.indexOf('workbench.web.main.js'));
    expect(adapter).toBeLessThan(
      html.indexOf('/vs/code/browser/workbench/workbench.js'),
    );
  });

  it('matches the bundled VS Code writer contract (check this adapter on runtime upgrades)', async () => {
    const source = await readFile(
      require.resolve('vscode-web/dist/out/vs/workbench/workbench.web.main.js'),
      'utf8',
    );
    expect(source).toContain('e.$1rb=B');
    expect(source).toContain('async j(U,K,V,G){const X=(0,f.$6e)');
    expect(source).toContain('k(U,K,V){return new Promise');
  });
});
