import { Injectable, signal } from '@angular/core';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

export function toWorkspaceRootUri(
  worktreePath: string,
  taskId?: number | null,
  generation?: string,
): string {
  const normalized = worktreePath.replace(/\\/g, '/').replace(/\/+$/, '') || worktreePath;
  return `workspace-vfs://elevenex/?worktreePath=${encodeURIComponent(normalized)}${taskId ? `&taskId=${taskId}` : ''}${generation ? `&generation=${encodeURIComponent(generation)}` : ''}`;
}

export function buildVSCodeIframeKey(
  projectId: number,
  worktreePath: string,
  taskId?: number | null,
): string {
  return `${projectId}${taskId ? `:task-${taskId}` : ''}:${worktreePath}`;
}

function resolveVSCodeBackendOrigin(): string {
  const backendOrigin = getBackendOrigin();

  if (typeof window === 'undefined') {
    return backendOrigin;
  }

  const currentOrigin = window.location.origin;
  if (backendOrigin !== currentOrigin) {
    return backendOrigin;
  }

  const currentUrl = new URL(currentOrigin);
  const isLocalDevHost = currentUrl.hostname === '127.0.0.1' || currentUrl.hostname === 'localhost';
  if (!isLocalDevHost || currentUrl.port !== '4200') {
    return backendOrigin;
  }

  currentUrl.port = '11111';
  return currentUrl.toString().replace(/\/+$/, '');
}

@Injectable({ providedIn: 'root' })
export class VSCodeWebStateService {
  private iframeInstances = new Map<string, HTMLIFrameElement>();
  private iframeVisibility = signal<Map<string, boolean>>(new Map());
  private iframeReady = signal<Map<string, boolean>>(new Map());
  private iframeTheme = new Map<string, boolean>();
  private readonly userAccess = new Set<string>();
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly parking = document.createElement('div');
  private readonly lastUsed = new Map<string, number>();
  private readonly geometryCleanup = new Map<string, () => void>();
  private eviction: Promise<void> | null = null;
  private evictionRequested = false;
  private readonly maxWarmEditors = 3;
  private destroyed = false;
  private readonly editorChecks = new Map<HTMLIFrameElement, Set<() => void>>();

  constructor() {
    this.parking.hidden = true;
    document.body.appendChild(this.parking);
  }

  private async checkEditor(iframe: HTMLIFrameElement, save = false): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const origin = new URL(iframe.src).origin;
      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', listener);
        this.editorChecks.get(iframe)?.delete(cancel);
        if (this.editorChecks.get(iframe)?.size === 0) this.editorChecks.delete(iframe);
      };
      const cancel = () => {
        cleanup();
        reject(new Error('Editor check cancelled'));
      };
      const listener = (event: MessageEvent) => {
        if (
          event.source !== iframe.contentWindow ||
          event.origin !== origin ||
          event.data?.type !== 'elevenex-editor-check-result' ||
          event.data.requestId !== requestId
        )
          return;
        cleanup();
        if (event.data.error || (save && event.data.dirty > 0))
          reject(
            new Error(
              event.data.error ||
                'Some editor documents are still unsaved. Save them before finishing.',
            ),
          );
        else resolve(Number(event.data.dirty) || 0);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            'The editor is not ready. Unsaved documents could not be checked; the editor has been preserved.',
          ),
        );
      }, 8000);
      if (!this.editorChecks.has(iframe)) this.editorChecks.set(iframe, new Set());
      this.editorChecks.get(iframe)!.add(cancel);
      window.addEventListener('message', listener);
      iframe.contentWindow?.postMessage({ type: 'elevenex-editor-check', requestId, save }, origin);
    });
  }

  recoverIframe(key: string): Promise<void> {
    const existing = this.recoveries.get(key);
    if (existing) return existing;
    const recovery = this.performRecovery(key).finally(() => {
      if (this.recoveries.get(key) === recovery) this.recoveries.delete(key);
    });
    this.recoveries.set(key, recovery);
    return recovery;
  }

  private async performRecovery(key: string): Promise<void> {
    const iframe = this.iframeInstances.get(key);
    if (!iframe) return;
    // A live bridge can reconnect without rebooting VS Code or losing buffers.
    const dirty = await this.checkEditor(iframe).catch(() => null);
    if (this.destroyed || this.iframeInstances.get(key) !== iframe) return;
    if (dirty !== null) {
      iframe.contentWindow?.postMessage(
        { type: 'elevenex-editor-retry' },
        new URL(iframe.src).origin,
      );
      return;
    }
    // A cross-origin iframe has a null contentDocument even when it contains
    // dirty documents. Absence of DOM access is never proof that it is clean.
    if (this.userAccess.has(key))
      throw new Error(
        'The filesystem extension is not responding. Use Show editor to save your documents before reloading. The editor has been preserved.',
      );
    // Startup was covered by the loader and never exposed to input. A fresh
    // generation also isolates any late messages from the abandoned worker.
    const url = new URL(iframe.src);
    const generation = crypto.randomUUID();
    url.searchParams.set('generation', generation);
    url.searchParams.set('theme', this.iframeTheme.get(key) ? 'dark' : 'light');
    const workspace = new URL(url.searchParams.get('workspace')!);
    workspace.searchParams.set('generation', generation);
    url.searchParams.set('workspace', workspace.toString());
    iframe.src = url.toString();
  }

  private evictInactive(): void {
    if (this.destroyed) return;
    if (this.eviction) {
      this.evictionRequested = true;
      return;
    }
    this.evictionRequested = false;
    this.eviction = (async () => {
      const inactive = [...this.lastUsed]
        .filter(([key]) => !this.isVisible(key))
        .sort((a, b) => a[1] - b[1]);
      for (const [key] of inactive) {
        if (this.iframeInstances.size <= this.maxWarmEditors) break;
        const iframe = this.iframeInstances.get(key);
        if (!iframe) continue;
        const dirty = await this.checkEditor(iframe).catch(() => null);
        // Unknown and dirty buffers are pinned. No save/close race: all actions
        // after this response are synchronous and re-check current ownership.
        if (dirty === 0 && this.iframeInstances.get(key) === iframe && !this.isVisible(key))
          this.destroyIframe(key);
      }
    })().finally(() => {
      this.eviction = null;
      if (this.evictionRequested) this.evictInactive();
    });
  }

  /** Check every mounted editor, including hidden tabs, before releasing a checkout. */
  async checkTaskEditors(worktreePath: string, save = false): Promise<number> {
    const editors = [...this.iframeInstances].filter(([key, iframe]) => {
      if (!key.endsWith(`:${worktreePath}`)) return false;
      // Angular removes the panel's container when Files is closed or the
      // route changes. Its iframe then has no browsing context, even though
      // hideIframe left the element cached. Only live editors can hold dirty
      // documents or answer the check; discard stale entries for recreation.
      if (!iframe.isConnected) {
        this.destroyIframe(key);
        return false;
      }
      return true;
    });
    const results = await Promise.all(editors.map(([, iframe]) => this.checkEditor(iframe, save)));
    return results.reduce((count, dirty) => count + dirty, 0);
  }

  destroyForPath(worktreePath: string): void {
    for (const key of [...this.iframeInstances.keys()])
      if (key.endsWith(`:${worktreePath}`)) this.destroyIframe(key);
  }

  getOrCreateIframe(
    iframeKey: string,
    worktreePath: string,
    container: HTMLElement,
    isDark: boolean,
    taskId?: number | null,
  ): HTMLIFrameElement {
    if (this.destroyed) throw new Error('Editor service was disposed');
    let existing = this.iframeInstances.get(iframeKey);
    if (existing && !existing.isConnected) {
      this.destroyIframe(iframeKey);
      existing = undefined;
    }
    if (existing) {
      this.showIframe(iframeKey, container);
      return existing;
    }

    if (this.iframeInstances.size >= 12)
      throw new Error(
        'Twelve editors are already retained. Save and close inactive task editors before opening another workspace.',
      );
    const iframe = document.createElement('iframe');
    iframe.className = 'w-full h-full border-0 bg-transparent';
    iframe.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
    );
    iframe.style.background = 'transparent';

    const generation = crypto.randomUUID();
    const params = new URLSearchParams({
      generation,
      workspace: toWorkspaceRootUri(worktreePath, taskId, generation),
      extensionPaths: '/vscode-ext1,/vscode-ext2',
      theme: isDark ? 'dark' : 'light',
    });
    iframe.src = `${resolveVSCodeBackendOrigin()}/vscode-static/index.html?${params.toString()}`;

    this.iframeInstances.set(iframeKey, iframe);
    this.attachIframe(iframe, container);
    this.iframeVisibility.update((m) => new Map(m).set(iframeKey, true));
    this.iframeTheme.set(iframeKey, isDark);
    this.lastUsed.set(iframeKey, Date.now());
    this.evictInactive();

    return iframe;
  }

  /** The filesystem extension uses VS Code's supported configuration API. */
  setTheme(iframeKey: string, isDark: boolean): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (!iframe || this.iframeTheme.get(iframeKey) === isDark) return;
    this.iframeTheme.set(iframeKey, isDark);
    iframe.contentWindow?.postMessage(
      { type: 'elevenex-editor-theme', isDark },
      new URL(iframe.src).origin,
    );
  }

  showIframe(iframeKey: string, container?: HTMLElement): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      if (container) {
        this.attachIframe(iframe, container);
      }
      iframe.classList.remove('hidden');
      this.iframeVisibility.update((m) => new Map(m).set(iframeKey, true));
      this.lastUsed.set(iframeKey, Date.now());
      iframe.contentWindow?.postMessage(
        { type: 'elevenex-editor-visibility', visible: true },
        new URL(iframe.src).origin,
      );
    }
  }

  hideIframe(iframeKey: string): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      iframe.contentWindow?.postMessage(
        { type: 'elevenex-editor-visibility', visible: false },
        new URL(iframe.src).origin,
      );
      iframe.classList.add('hidden');
      this.geometryCleanup.get(iframeKey)?.();
      this.geometryCleanup.delete(iframeKey);
      // moveBefore preserves the browsing context; appendChild does not.
      if ('moveBefore' in this.parking && iframe.isConnected)
        (this.parking as any).moveBefore(iframe, null);
      this.iframeVisibility.update((m) => new Map(m).set(iframeKey, false));
      this.evictInactive();
    }
  }

  destroyIframe(iframeKey: string): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      this.geometryCleanup.get(iframeKey)?.();
      this.geometryCleanup.delete(iframeKey);
      this.lastUsed.delete(iframeKey);
      for (const cancel of this.editorChecks.get(iframe) ?? []) cancel();
      iframe.remove();
      this.iframeInstances.delete(iframeKey);
      this.iframeVisibility.update((m) => {
        const newMap = new Map(m);
        newMap.delete(iframeKey);
        return newMap;
      });
      this.iframeReady.update((m) => {
        const newMap = new Map(m);
        newMap.delete(iframeKey);
        return newMap;
      });
      this.iframeTheme.delete(iframeKey);
      this.userAccess.delete(iframeKey);
    }
  }

  hasIframe(iframeKey: string): boolean {
    return this.iframeInstances.has(iframeKey);
  }

  isVisible(iframeKey: string): boolean {
    return this.iframeVisibility().get(iframeKey) ?? false;
  }

  getIframe(iframeKey: string): HTMLIFrameElement | undefined {
    return this.iframeInstances.get(iframeKey);
  }

  isReady(iframeKey: string): boolean {
    return this.iframeReady().get(iframeKey) ?? false;
  }

  markUserAccess(iframeKey: string): void {
    this.userAccess.add(iframeKey);
  }

  setReady(iframeKey: string, ready: boolean): void {
    if (ready) this.markUserAccess(iframeKey);
    this.iframeReady.update((m) => new Map(m).set(iframeKey, ready));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const key of [...this.iframeInstances.keys()]) this.destroyIframe(key);
    this.parking.remove();
  }

  private attachIframe(iframe: HTMLIFrameElement, container: HTMLElement): void {
    const key = [...this.iframeInstances].find(([, value]) => value === iframe)?.[0] || '';
    this.geometryCleanup.get(key)?.();
    if ('moveBefore' in container) {
      if (!iframe.isConnected) this.parking.appendChild(iframe);
      (container as any).moveBefore(iframe, null);
      return;
    }
    // Older browsers have no state-preserving DOM move. Keep the iframe in a
    // stable connected host and follow the mount's geometry without reparenting.
    if (!iframe.isConnected) document.body.appendChild(iframe);
    const update = () => {
      const rect = container.getBoundingClientRect();
      Object.assign(iframe.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        zIndex: '10',
      });
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(container);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    this.geometryCleanup.set(key, () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    });
  }
}
