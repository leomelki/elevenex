/**
 * Adapter for the bundled VS Code 1.91.1 FileUpload ($1rb) implementation.
 * Its streaming (j) and buffered (k) writers normally report local file reads:
 * our extension then buffers those bytes before starting the HTTP request.
 * Upload the browser File directly so the existing notification counts network
 * progress instead, without buffering large files in the extension worker.
 * Keep this function self-contained: it is serialized into the workbench page.
 */
export function installVSCodeUploadProgress(
  FileUpload: { prototype: Record<string, any> },
  workspace: string | null,
): void {
  if (!workspace) return;
  const workspaceUrl = new URL(workspace, window.location.origin);
  if (workspaceUrl.protocol !== 'workspace-vfs:') return;
  const workspaceParams = workspaceUrl.searchParams;
  const prototype = FileUpload.prototype;

  const upload = (
    resource: { scheme: string; query: string; path: string },
    file: File,
    report: (total: number, increment: number) => void,
    token?: {
      isCancellationRequested: boolean;
      onCancellationRequested: (listener: () => void) => { dispose(): void };
    },
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (token?.isCancellationRequested) {
        resolve();
        return;
      }
      const params = new URLSearchParams(resource.query);
      const worktree =
        params.get('worktreePath') || workspaceParams.get('worktreePath');
      if (!worktree) {
        reject(new Error('Missing upload worktree'));
        return;
      }
      const xhr = new XMLHttpRequest();
      const query = new URLSearchParams({
        path: resource.path.replace(/^\/+/, ''),
      });
      xhr.open(
        'PUT',
        '/api/worktrees/' + encodeURIComponent(worktree) + '/raw?' + query,
      );
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      const taskId = params.get('taskId') || workspaceParams.get('taskId');
      if (taskId) xhr.setRequestHeader('x-elevenex-task-id', taskId);
      let loaded = 0;
      const progress = (bytes: number) => {
        const next = Math.max(loaded, Math.min(file.size, bytes));
        report(file.size, next - loaded);
        loaded = next;
      };
      // Keep the final byte pending until the backend has committed the file.
      xhr.upload.onprogress = (event) =>
        progress(Math.min(event.loaded, Math.max(0, file.size - 1)));
      let cancellation: { dispose(): void } | undefined;
      const cleanup = () => {
        cancellation?.dispose();
        xhr.upload.onprogress = null;
        xhr.onload = xhr.onerror = xhr.onabort = null;
      };
      xhr.onload = () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          progress(file.size);
          resolve();
        } else {
          reject(new Error('Upload failed (HTTP ' + xhr.status + ')'));
        }
      };
      xhr.onerror = () => {
        cleanup();
        reject(new Error('Upload failed: network error'));
      };
      xhr.onabort = () => {
        cleanup();
        resolve();
      };
      cancellation = token?.onCancellationRequested(() => xhr.abort());
      try {
        xhr.send(file);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });

  for (const method of ['j', 'k']) {
    const original = prototype[method];
    if (typeof original !== 'function')
      throw new Error('Unsupported VS Code upload implementation');
    prototype[method] = function (...args: Parameters<typeof upload>) {
      const [resource, file, report, token] = args;
      if (resource.scheme !== 'workspace-vfs')
        return original.apply(this, args);
      return upload(resource, file, report, token);
    };
  }
}

export function buildVSCodeUploadProgressScript(): string {
  return `<script>
require(['vs/workbench/contrib/files/browser/fileImportExport'], function (uploads) {
  (${installVSCodeUploadProgress.toString()})(uploads.$1rb, new URLSearchParams(window.location.search).get('workspace'));
});
</script>\n`;
}
