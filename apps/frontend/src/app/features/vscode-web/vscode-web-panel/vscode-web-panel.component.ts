import { Component, input, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VSCodeWebStateService, buildVSCodeIframeKey } from '../vscode-web-state.service';
import { getWebSocketUrl } from '@/shared/runtime/runtime-config';

@Component({
  selector: 'app-vscode-web-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div #container class="relative h-full w-full isolate overflow-hidden bg-background">
      <div
        class="vscode-loader absolute inset-0 z-30 overflow-hidden transition-opacity duration-300"
        [class.opacity-100]="isLoading()"
        [class.opacity-0]="!isLoading()"
        [class.pointer-events-none]="!isLoading()"
        [attr.aria-hidden]="!isLoading()"
      >
        <div class="absolute inset-0 vscode-loader__mesh"></div>
        <div class="absolute inset-0 vscode-loader__glow"></div>
        <div class="absolute left-1/2 top-1/2 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full vscode-loader__halo"></div>

        <div class="relative z-10 flex h-full items-center justify-center p-6">
          <div class="w-full max-w-sm rounded-[28px] border border-[color-mix(in_oklch,var(--border)_84%,var(--surface-tint)_12%)] bg-[color-mix(in_oklch,var(--background)_82%,var(--surface-tint)_10%)] px-7 py-8 shadow-[0_28px_90px_color-mix(in_oklch,var(--surface-shade)_18%,transparent)] backdrop-blur-2xl">
            <div class="flex flex-col items-center text-center">
              <div class="relative mb-6 flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border border-[color-mix(in_oklch,var(--primary)_28%,var(--border))] bg-[color-mix(in_oklch,var(--background)_74%,var(--surface-tint))] shadow-[0_18px_45px_color-mix(in_oklch,var(--primary)_18%,transparent)]">
                <div class="vscode-loader__orb"></div>
                <div class="vscode-loader__orb vscode-loader__orb--delayed"></div>
                <div class="relative h-8 w-8 rounded-xl border border-[color-mix(in_oklch,var(--primary)_42%,var(--border))] bg-[linear-gradient(180deg,color-mix(in_oklch,var(--primary)_20%,var(--surface-tint)),color-mix(in_oklch,var(--primary)_32%,var(--background)))] shadow-inner shadow-[color-mix(in_oklch,var(--surface-tint)_70%,transparent)]"></div>
              </div>

              <div class="space-y-2">
                <p class="text-[15px] font-semibold tracking-[-0.01em] text-foreground">Opening VS Code</p>
                <p class="mx-auto max-w-[18rem] text-sm leading-6 text-muted-foreground">
                  Preparing the workspace, extensions, and Git view.
                </p>
              </div>

              <div class="mt-6 flex items-center gap-2 rounded-full border border-[color-mix(in_oklch,var(--border)_82%,var(--surface-tint)_12%)] bg-[color-mix(in_oklch,var(--muted)_64%,var(--surface-tint)_12%)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                <span class="vscode-loader__pulse"></span>
                <span>Booting workspace</span>
              </div>

              @if (startupIssue()) {
                <p class="mt-4 text-xs leading-5 text-[color-mix(in_oklch,var(--warning)_78%,var(--foreground))]">{{ startupIssue() }}</p>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .vscode-loader {
      background:
        linear-gradient(180deg, color-mix(in oklch, var(--background) 96%, var(--surface-tint) 4%), color-mix(in oklch, var(--background) 98%, transparent));
    }

    .vscode-loader__mesh {
      background:
        radial-gradient(circle at 20% 20%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 28%),
        radial-gradient(circle at 80% 30%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 26%),
        linear-gradient(135deg, color-mix(in oklch, var(--muted-foreground) 14%, transparent), transparent 60%);
      opacity: 1;
    }

    .vscode-loader__glow {
      background-image:
        linear-gradient(90deg, transparent, color-mix(in oklch, var(--primary) 18%, transparent), transparent);
      transform: translateX(-100%);
      animation: vscode-loader-scan 2.8s ease-in-out infinite;
      opacity: 0.9;
    }

    .vscode-loader__halo {
      background:
        radial-gradient(circle, color-mix(in oklch, var(--primary) 18%, transparent), color-mix(in oklch, var(--primary) 6%, transparent) 38%, transparent 68%);
      filter: blur(16px);
      animation: vscode-loader-breathe 3.2s ease-in-out infinite;
      opacity: 0.85;
    }

    .vscode-loader__orb {
      position: absolute;
      inset: -42%;
      background: conic-gradient(
        from 180deg,
        transparent,
        color-mix(in oklch, var(--primary) 55%, transparent),
        transparent 70%
      );
      animation: vscode-loader-spin 2.4s linear infinite;
    }

    .vscode-loader__orb--delayed {
      animation-direction: reverse;
      animation-duration: 3.4s;
      opacity: 0.45;
    }

    .vscode-loader__pulse {
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 9999px;
      background: var(--primary);
      box-shadow: 0 0 0 0 color-mix(in oklch, var(--primary) 35%, transparent);
      animation: vscode-loader-pulse 1.8s ease-out infinite;
    }

    @keyframes vscode-loader-spin {
      to { transform: rotate(360deg); }
    }

    @keyframes vscode-loader-breathe {
      0%, 100% { transform: translate(-50%, -50%) scale(0.94); opacity: 0.72; }
      50% { transform: translate(-50%, -50%) scale(1.06); opacity: 1; }
    }

    @keyframes vscode-loader-pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--primary) 35%, transparent); opacity: 1; }
      70% { box-shadow: 0 0 0 12px color-mix(in oklch, var(--primary) 0%, transparent); opacity: 0.75; }
      100% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--primary) 0%, transparent); opacity: 0.75; }
    }

    @keyframes vscode-loader-scan {
      0% { transform: translateX(-100%); }
      55%, 100% { transform: translateX(100%); }
    }
  `],
  host: { class: 'block w-full h-full' },
})
export class VSCodeWebPanelComponent implements AfterViewInit, OnDestroy {
  sessionId = input.required<number>();
  projectId = input.required<number>();
  worktreePath = input.required<string>();

  @ViewChild('container', { static: true }) container!: ElementRef<HTMLDivElement>;

  private stateService = inject(VSCodeWebStateService);
  isLoading = signal(true);
  startupIssue = signal<string | null>(null);
  private currentSessionId: number | null = null;
  private currentIframeKey: string | null = null;
  private currentWorktreePath: string | null = null;
  private readyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private fileChangeSocket: WebSocket | null = null;
  private pendingFileToReveal: string | null = null;
  private readonly handleWindowMessage = (event: MessageEvent): void => {
    if (event.data?.type !== 'vscode-workbench-ready' || this.currentIframeKey === null) {
      return;
    }

    const iframe = this.stateService.getIframe(this.currentIframeKey);
    if (!iframe || event.source !== iframe.contentWindow) {
      return;
    }

    this.stateService.setReady(this.currentIframeKey, true);
    this.isLoading.set(false);
    this.startupIssue.set(null);
    this.clearReadyTimeout();
    this.flushPendingFileReveal(this.currentIframeKey);
  };

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      const projectId = this.projectId();
      const path = this.worktreePath();
      if (!path) return;

      if (sessionId !== this.currentSessionId || this.currentSessionId === null) {
        this.handleSessionChange(sessionId, projectId, path);
      }
    });
  }

  ngAfterViewInit(): void {
    window.addEventListener('message', this.handleWindowMessage);
    const sessionId = this.sessionId();
    const projectId = this.projectId();
    const path = this.worktreePath();
    if (path) {
      this.createOrShowIframe(sessionId, projectId, path);
    }
  }

  private handleSessionChange(newSessionId: number, projectId: number, newPath: string): void {
    if (this.currentSessionId !== null && this.currentSessionId !== newSessionId) {
      if (this.currentIframeKey) {
        this.stateService.hideIframe(this.currentIframeKey);
      }
    }

    if (this.currentWorktreePath !== newPath) {
      this.currentWorktreePath = newPath;
      this.connectFileChangeSocket(newPath);
    }

    this.currentSessionId = newSessionId;
    this.currentIframeKey = buildVSCodeIframeKey(projectId, newPath);
    this.createOrShowIframe(newSessionId, projectId, newPath);
  }

  private createOrShowIframe(sessionId: number, projectId: number, worktreePath: string): void {
    if (!this.container) return;

    const container = this.container.nativeElement;
    const iframeKey = buildVSCodeIframeKey(projectId, worktreePath);
    this.startupIssue.set(null);
    
    if (this.stateService.hasIframe(iframeKey)) {
      this.stateService.showIframe(iframeKey, container);
      this.stateService.setReady(iframeKey, false);
      this.isLoading.set(true);
      this.armReadyTimeout(iframeKey, sessionId);
      this.requestWorkbenchReady(iframeKey);
    } else {
      this.stateService.setReady(iframeKey, false);
      this.isLoading.set(true);
      const iframe = this.stateService.getOrCreateIframe(iframeKey, worktreePath, container);
      this.armReadyTimeout(iframeKey, sessionId);
      iframe.addEventListener('load', () => {
        if (this.currentSessionId === sessionId) {
          this.requestWorkbenchReady(iframeKey);
        }
      }, { once: true });
    }
  }

  private armReadyTimeout(iframeKey: string, sessionId: number): void {
    this.clearReadyTimeout();
    this.readyTimeoutId = setTimeout(() => {
      if (this.currentSessionId !== sessionId || this.stateService.isReady(iframeKey)) {
        return;
      }

      const iframe = this.stateService.getIframe(iframeKey);
      console.error('VS Code Web did not signal readiness within 15s', {
        sessionId,
        iframeSrc: iframe?.src,
      });
      this.startupIssue.set('VS Code is taking longer than expected. Open the browser console and network tab for iframe startup errors.');
    }, 15000);
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeoutId) {
      clearTimeout(this.readyTimeoutId);
      this.readyTimeoutId = null;
    }
  }

  private requestWorkbenchReady(iframeKey: string): void {
    const iframe = this.stateService.getIframe(iframeKey);
    if (!iframe?.contentWindow) {
      return;
    }

    iframe.contentWindow.postMessage({ type: 'vscode-workbench-check-ready' }, '*');
  }

  private connectFileChangeSocket(worktreePath: string): void {
    this.disconnectFileChangeSocket();
    this.pendingFileToReveal = null;

    const socketUrl = getWebSocketUrl('/file-changes', new URLSearchParams({
      worktreePath,
    }));
    const socket = new WebSocket(socketUrl);
    this.fileChangeSocket = socket;

    socket.onmessage = (event: MessageEvent<string>) => {
      this.handleFileChangeSocketMessage(event);
    };

    socket.onerror = (event: Event) => {
      console.error('VS Code file change bridge socket error', event);
    };

    socket.onclose = () => {
      if (this.fileChangeSocket === socket) {
        this.fileChangeSocket = null;
      }
    };
  }

  private disconnectFileChangeSocket(): void {
    if (this.fileChangeSocket) {
      this.fileChangeSocket.close();
      this.fileChangeSocket = null;
    }
  }

  private handleFileChangeSocketMessage(event: MessageEvent<string>): void {
    const payload = this.parseFileChangePayload(event.data);
    for (const change of payload) {
      if (change.event === 'addDir' || change.event === 'unlinkDir') {
        continue;
      }

      if (change.event !== 'add' && change.event !== 'change') {
        continue;
      }

      if (!change.path) {
        continue;
      }

      this.openOrRevealChangedFile(change.path);
    }
  }

  private parseFileChangePayload(data: string): Array<{ event?: string; path?: string }> {
    try {
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      console.error('Failed to parse file change bridge payload', error);
      return [];
    }
  }

  private openOrRevealChangedFile(path: string): void {
    const normalizedPath = path.replace(/^\/+/, '');
    if (!normalizedPath || this.currentIframeKey === null) {
      return;
    }

    if (!this.stateService.isReady(this.currentIframeKey)) {
      this.pendingFileToReveal = normalizedPath;
      return;
    }

    const iframe = this.stateService.getIframe(this.currentIframeKey);
    if (!iframe?.contentWindow) {
      this.pendingFileToReveal = normalizedPath;
      return;
    }

    iframe.contentWindow.postMessage({
      type: 'elevenex-open-file',
      path: normalizedPath,
      preserveFocus: true,
    }, '*');
  }

  private flushPendingFileReveal(iframeKey: string): void {
    if (!this.pendingFileToReveal || this.currentIframeKey !== iframeKey) {
      return;
    }

    const pendingPath = this.pendingFileToReveal;
    this.pendingFileToReveal = null;
    this.openOrRevealChangedFile(pendingPath);
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.handleWindowMessage);
    this.clearReadyTimeout();
    this.disconnectFileChangeSocket();
    if (this.currentIframeKey !== null) {
      this.stateService.hideIframe(this.currentIframeKey);
    }
  }
}
