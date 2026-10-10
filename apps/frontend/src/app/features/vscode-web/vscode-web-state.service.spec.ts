import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMemoryLocalStorage } from '@/shared/testing/memory-storage';
import { buildVSCodeIframeKey, toWorkspaceRootUri, VSCodeWebStateService } from './vscode-web-state.service';

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
    service.destroyForPath(worktreePath);
    container.remove();
    delete window.__ELEVENEX_RUNTIME__;
    restoreStorage();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function createEditor(path = worktreePath): HTMLIFrameElement {
    return service.getOrCreateIframe(buildVSCodeIframeKey(1, path), path, container, false, 42);
  }

  function reply(iframe: HTMLIFrameElement, requestId: string, dirty: number, error?: string): void {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin,
      data: { type: 'elevenex-editor-check-result', requestId, dirty, error },
    }));
  }

  it('discards editors whose panel was removed instead of timing out when finishing', async () => {
    const key = buildVSCodeIframeKey(1, worktreePath);
    const iframe = createEditor();
    service.setReady(key, true);
    service.hideIframe(key);
    container.remove();

    expect(iframe.isConnected).toBe(false);
    await expect(service.checkTaskEditors(worktreePath)).resolves.toBe(0);
    await expect(service.checkTaskEditors(worktreePath, true)).resolves.toBe(0);
    expect(service.hasIframe(key)).toBe(false);
    expect(service.isReady(key)).toBe(false);

    document.body.appendChild(container);
    expect(createEditor()).not.toBe(iframe);
  });

  it('still checks hidden live editors through the paired backend origin', async () => {
    const iframe = createEditor();
    service.hideIframe(buildVSCodeIframeKey(1, worktreePath));
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    const check = service.checkTaskEditors(worktreePath);
    const request = postMessage.mock.calls[0][0];
    expect(postMessage).toHaveBeenCalledWith({
      type: 'elevenex-editor-check', requestId: expect.any(String), save: false,
    }, origin);
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
});
