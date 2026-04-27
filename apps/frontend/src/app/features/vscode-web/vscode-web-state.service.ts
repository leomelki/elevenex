import { Injectable, signal, computed } from '@angular/core';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

function toWorkspaceRootUri(worktreePath: string): string {
  const normalized = worktreePath.replace(/\/+$/, '');
  return `workspace-vfs://${encodeURIComponent(normalized)}/`;
}

export function buildVSCodeIframeKey(projectId: number, worktreePath: string): string {
  return `${projectId}:${worktreePath}`;
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

  getOrCreateIframe(iframeKey: string, worktreePath: string, container: HTMLElement): HTMLIFrameElement {
    const existing = this.iframeInstances.get(iframeKey);
    if (existing) {
      this.attachIframe(existing, container);
      return existing;
    }

    const iframe = document.createElement('iframe');
    iframe.className = 'w-full h-full border-0 bg-transparent';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    iframe.style.background = 'transparent';

    const params = new URLSearchParams({
      workspace: toWorkspaceRootUri(worktreePath),
      extensionPaths: '/vscode-ext1,/vscode-ext2',
    });
    iframe.src = `${resolveVSCodeBackendOrigin()}/vscode-static/index.html?${params.toString()}`;

    this.attachIframe(iframe, container);
    this.iframeInstances.set(iframeKey, iframe);
    this.iframeVisibility.update(m => new Map(m).set(iframeKey, true));

    return iframe;
  }

  showIframe(iframeKey: string, container?: HTMLElement): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      if (container) {
        this.attachIframe(iframe, container);
      }
      iframe.classList.remove('hidden');
      this.iframeVisibility.update(m => new Map(m).set(iframeKey, true));
    }
  }

  hideIframe(iframeKey: string): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      iframe.classList.add('hidden');
      this.iframeVisibility.update(m => new Map(m).set(iframeKey, false));
    }
  }

  destroyIframe(iframeKey: string): void {
    const iframe = this.iframeInstances.get(iframeKey);
    if (iframe) {
      iframe.remove();
      this.iframeInstances.delete(iframeKey);
      this.iframeVisibility.update(m => {
        const newMap = new Map(m);
        newMap.delete(iframeKey);
        return newMap;
      });
      this.iframeReady.update(m => {
        const newMap = new Map(m);
        newMap.delete(iframeKey);
        return newMap;
      });
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

  setReady(iframeKey: string, ready: boolean): void {
    this.iframeReady.update(m => new Map(m).set(iframeKey, ready));
  }

  private attachIframe(iframe: HTMLIFrameElement, container: HTMLElement): void {
    if (iframe.parentElement !== container) {
      container.appendChild(iframe);
    }
  }
}
