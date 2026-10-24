import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryLocalStorage } from '@/shared/testing/memory-storage';
import {
  buildVSCodeIframeKey,
  toWorkspaceRootUri,
  VSCodeWebStateService,
} from './vscode-web-state.service';

describe('toWorkspaceRootUri', () => {
  it('binds the editor to a stable task identity independently of the checkout path', () => {
    const uri = new URL(toWorkspaceRootUri('/tmp/checkouts/reused', 42));
    expect(uri.searchParams.get('taskId')).toBe('42');
    expect(uri.searchParams.get('worktreePath')).toBe('/tmp/checkouts/reused');
  });
  it('keeps mixed-case filesystem paths out of the hostname authority', () => {
    const worktreePath =
      '/home/bits/go/src/github.com/DataDog/.worktrees/dd-go/fingerprint-migration-investigation';
    const uri = new URL(toWorkspaceRootUri(worktreePath));

    expect(uri.hostname).toBe('elevenex');
    expect(uri.searchParams.get('worktreePath')).toBe(worktreePath);
  });
});

describe('checkTaskEditors', () => {
  const worktreePath = '/tmp/checkouts/paired-desktop';
  const origin = 'http://127.0.0.1:43123';
  let service: VSCodeWebStateService;
  let container: HTMLDivElement;
  let restoreStorage: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreStorage = installMemoryLocalStorage();
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: origin };
    service = new VSCodeWebStateService();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    service.ngOnDestroy();
    container.remove();
    delete window.__ELEVENEX_RUNTIME__;
    restoreStorage();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createEditor(path = worktreePath): HTMLIFrameElement {
    return service.getOrCreateIframe(buildVSCodeIframeKey(1, path), path, container, false, 42);
  }

  function reply(
    iframe: HTMLIFrameElement,
    requestId: string,
    dirty: number,
    error?: string,
  ): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        origin,
        data: { type: 'elevenex-editor-check-result', requestId, dirty, error },
      }),
    );
  }

  it('retains a connected browsing context when its panel is removed', async () => {
    const key = buildVSCodeIframeKey(1, worktreePath);
    const iframe = createEditor();
    const context = iframe.contentWindow;
    service.hideIframe(key);
    container.remove();
    expect(iframe.isConnected).toBe(true);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    const check = service.checkTaskEditors(worktreePath);
    reply(iframe, post.mock.calls[0][0].requestId, 2);
    await expect(check).resolves.toBe(2);
    document.body.appendChild(container);
    expect(createEditor()).toBe(iframe);
    expect(iframe.contentWindow).toBe(context);
  });

  it('updates the live theme without changing iframe.src or readiness', () => {
    const key = buildVSCodeIframeKey(1, worktreePath);
    const iframe = createEditor();
    const src = iframe.src;
    service.setReady(key, true);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    service.setTheme(key, true);
    expect(iframe.src).toBe(src);
    expect(service.isReady(key)).toBe(true);
    expect(post).toHaveBeenCalledWith({ type: 'elevenex-editor-theme', isDark: true }, origin);
  });

  it('keeps reused checkout paths isolated by task', () => {
    expect(buildVSCodeIframeKey(1, worktreePath, 42)).not.toBe(
      buildVSCodeIframeKey(1, worktreePath, 43),
    );
  });

  it('preserves an unresponsive editor that has been exposed to editing', async () => {
    const key = buildVSCodeIframeKey(1, worktreePath);
    const iframe = createEditor();
    const src = iframe.src;
    service.markUserAccess(key);
    const retry = service.recoverIframe(key);
    const rejected = expect(retry).rejects.toThrow('preserved');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(iframe.src).toBe(src);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('evicts clean inactive editors to three while pinning dirty buffers', async () => {
    const check = vi.spyOn(service as any, 'checkEditor').mockResolvedValue(1);
    for (let i = 0; i < 4; i++) {
      const key = buildVSCodeIframeKey(1, `${worktreePath}-${i}`);
      service.getOrCreateIframe(key, `${worktreePath}-${i}`, container, false);
      if (i < 3) service.hideIframe(key);
    }
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((service as any).iframeInstances.size).toBe(4);
    check.mockResolvedValue(0);
    service.hideIframe(buildVSCodeIframeKey(1, `${worktreePath}-3`));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((service as any).iframeInstances.size).toBe(3);
  });

  it('recreates detached cached iframes instead of treating them as warm', () => {
    const first = createEditor();
    first.remove();
    expect(createEditor()).not.toBe(first);
  });

  it('still checks hidden live editors through the paired backend origin', async () => {
    const iframe = createEditor();
    service.hideIframe(buildVSCodeIframeKey(1, worktreePath));
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const check = service.checkTaskEditors(worktreePath);
    const request = postMessage.mock.calls[0][0];
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'elevenex-editor-check',
        requestId: expect.any(String),
        save: false,
      },
      origin,
    );
    reply(iframe, request.requestId, 2);

    await expect(check).resolves.toBe(2);
  });

  it('blocks finishing if a live editor still has dirty documents after saving', async () => {
    const iframe = createEditor();
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const check = service.checkTaskEditors(worktreePath, true);
    const result = expect(check).rejects.toThrow('Some editor documents are still unsaved.');
    const request = postMessage.mock.calls[0][0];
    expect(request.save).toBe(true);
    reply(iframe, request.requestId, 1);

    await result;
  });

  it('still rejects an unresponsive live editor', async () => {
    createEditor();
    const check = service.checkTaskEditors(worktreePath);
    const result = expect(check).rejects.toThrow('The editor is not ready.');

    await vi.advanceTimersByTimeAsync(8000);

    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces rapid retries and cancels checks when their iframe is destroyed', async () => {
    const key = buildVSCodeIframeKey(1, worktreePath);
    const iframe = createEditor();
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    const first = service.recoverIframe(key);
    const second = service.recoverIframe(key);
    expect(first).toBe(second);
    expect(post).toHaveBeenCalledTimes(1);
    service.destroyIframe(key);
    await first;
    expect((service as any).editorChecks.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0); // Drain the browser's queued postMessage event.
    expect(service.hasIframe(key)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
