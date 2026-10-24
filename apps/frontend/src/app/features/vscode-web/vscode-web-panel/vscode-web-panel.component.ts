import {
  Component,
  input,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { VSCodeWebStateService, buildVSCodeIframeKey } from '../vscode-web-state.service';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import { ThemeService } from '@/shared/services/theme.service';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';

@Component({
  selector: 'app-vscode-web-panel',
  standalone: true,
  imports: [CommonModule, ZardButtonComponent],
  templateUrl: './vscode-web-panel.component.html',
  styleUrl: './vscode-web-panel.component.scss',
  host: { class: 'block w-full h-full' },
})
export class VSCodeWebPanelComponent implements AfterViewInit, OnDestroy {
  sessionId = input.required<number>();
  projectId = input.required<number>();
  worktreePath = input.required<string>();
  taskId = input<number | null>();
  /** Delay cold workbench startup while the session's chat is loading. */
  startupAllowed = input(true);

  @ViewChild('container', { static: true }) container!: ElementRef<HTMLDivElement>;

  private stateService = inject(VSCodeWebStateService);
  private themeService = inject(ThemeService);
  isLoading = signal(true);
  startupIssue = signal<string | null>(null);
  private currentSessionId: number | null = null;
  private currentIframeKey: string | null = null;
  private currentWorktreePath: string | null = null;
  private readyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private pendingFileToReveal: { target: LocalFileTarget; preserveFocus: boolean } | null = null;
  private probeId = '';
  private iframeGeneration = '';
  private removeLoadListener?: () => void;
  private revealTimer?: ReturnType<typeof setTimeout>;
  private pendingAutoReveal: string | null = null;
  private destroyed = false;
  private recoveryVersion = 0;
  private startupDeadlineAt = 0;
  private forcedSessionId = signal<number | null>(null);
  private deferredTimer?: ReturnType<typeof setTimeout>;
  private deferredScope: string | null = null;
  stageLabel = signal('Navigating to the editor…');
  private readonly handleWindowMessage = (event: MessageEvent): void => {
    if (!this.currentIframeKey || this.destroyed) return;
    const iframe = this.stateService.getIframe(this.currentIframeKey);
    if (
      !iframe ||
      event.source !== iframe.contentWindow ||
      event.origin !== new URL(iframe.src).origin
    )
      return;
    const data = event.data;
    if (data?.generation !== this.iframeGeneration || data?.requestId !== this.probeId) return;
    if (
      data.type === 'elevenex-editor-startup-error' ||
      data.type === 'elevenex-editor-sync-error'
    ) {
      this.failStartup(data.message || 'The editor connection failed. Retry to reconnect.');
    } else if (data.type === 'elevenex-editor-file-changes') {
      this.handleFileChangeSocketMessage({
        data: JSON.stringify(data.changes),
      } as MessageEvent<string>);
    } else if (data.type === 'elevenex-editor-stage' && !this.startupIssue()) {
      this.stageLabel.set(
        data.stage === 'workbench'
          ? 'Waiting for the filesystem extension…'
          : 'Connecting the workspace…',
      );
    } else if (
      data.type === 'vscode-workbench-ready' &&
      data.workspaceReady &&
      data.bridgeReady &&
      !this.startupIssue()
    ) {
      this.stateService.setReady(this.currentIframeKey, true);
      this.isLoading.set(false);
      this.clearReadyTimeout();
      this.flushPendingFileReveal(this.currentIframeKey);
    }
  };

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      const projectId = this.projectId();
      const path = this.worktreePath();
      if (!path) return;
      if (
        !this.startupAllowed() &&
        this.forcedSessionId() !== sessionId &&
        !this.stateService.hasIframe(buildVSCodeIframeKey(projectId, path, this.taskId()))
      ) {
        // A cold session switch must not leave the previous session's files
        // visible while its new transcript is loading.
        if (this.currentIframeKey) {
          this.stateService.hideIframe(this.currentIframeKey);
          this.currentIframeKey = null;
          this.cleanupAttempt();
        }
        this.waitForSessionSetup(
          sessionId,
          `${sessionId}:${buildVSCodeIframeKey(projectId, path, this.taskId())}`,
        );
        return;
      }

      if (
        sessionId !== this.currentSessionId ||
        this.currentIframeKey !== buildVSCodeIframeKey(projectId, path, this.taskId())
      ) {
        this.handleSessionChange(sessionId, projectId, path);
      }
    });

    effect(() => {
      const isDark = this.themeService.isDark();
      if (this.currentIframeKey === null) return;
      this.stateService.setTheme(this.currentIframeKey, isDark);
    });
  }

  ngAfterViewInit(): void {
    window.addEventListener('message', this.handleWindowMessage);
    if (this.currentIframeKey && !this.removeLoadListener)
      this.createOrShowIframe(this.sessionId(), this.projectId(), this.worktreePath());
  }

  private waitForSessionSetup(sessionId: number, scope: string): void {
    if (this.deferredScope === scope) return;
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredScope = scope;
    this.isLoading.set(true);
    this.startupIssue.set(null);
    this.stageLabel.set('Waiting for session setup…');
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = undefined;
      if (
        !this.destroyed &&
        this.sessionId() === sessionId &&
        this.deferredScope === scope &&
        !this.currentIframeKey
      ) {
        this.isLoading.set(false);
        this.startupIssue.set(
          'Session setup did not finish within 30 seconds. Retry to open the editor now.',
        );
      }
    }, 30_000);
  }

  private handleSessionChange(newSessionId: number, projectId: number, newPath: string): void {
    this.cleanupAttempt();
    if (this.currentIframeKey) this.stateService.hideIframe(this.currentIframeKey);
    this.pendingFileToReveal = null;
    this.currentSessionId = newSessionId;
    this.currentWorktreePath = newPath;
    this.currentIframeKey = buildVSCodeIframeKey(projectId, newPath, this.taskId());
    this.createOrShowIframe(newSessionId, projectId, newPath);
  }

  private createOrShowIframe(sessionId: number, projectId: number, worktreePath: string): void {
    if (!this.container || this.destroyed) return;
    this.cleanupAttempt();
    const key = buildVSCodeIframeKey(projectId, worktreePath, this.taskId());
    this.currentIframeKey = key;
    this.currentSessionId = sessionId;
    this.isLoading.set(true);
    this.startupIssue.set(null);
    this.startupDeadlineAt = Date.now() + 30_000;
    this.stageLabel.set('Navigating to the editor…');
    let iframe: HTMLIFrameElement;
    try {
      iframe = this.stateService.getOrCreateIframe(
        key,
        worktreePath,
        this.container.nativeElement,
        this.themeService.isDark(),
        this.taskId(),
      );
    } catch (error) {
      this.failStartup(error instanceof Error ? error.message : 'Could not create the editor.');
      return;
    }
    this.iframeGeneration = new URL(iframe.src).searchParams.get('generation') || '';
    const loaded = () => {
      if (this.currentIframeKey !== key || this.destroyed || this.startupIssue()) return;
      if (!this.isLoading()) this.startupDeadlineAt = Date.now() + 30_000;
      this.probeId = crypto.randomUUID();
      this.stateService.setReady(key, false);
      this.isLoading.set(true);
      this.startupIssue.set(null);
      this.stageLabel.set('Starting the workbench…');
      this.armReadyTimeout(key, sessionId);
      this.requestWorkbenchReady(key);
    };
    iframe.addEventListener('load', loaded);
    const failed = () =>
      this.failStartup(
        'The editor runtime could not be loaded. Check the backend connection and retry.',
      );
    iframe.addEventListener('error', failed);
    this.removeLoadListener = () => {
      iframe.removeEventListener('load', loaded);
      iframe.removeEventListener('error', failed);
    };
    loaded(); // Probe a warm context too; load may already have fired.
    this.stateService.setTheme(key, this.themeService.isDark());
  }

  private armReadyTimeout(iframeKey: string, sessionId: number): void {
    this.clearReadyTimeout();
    this.readyTimeoutId = setTimeout(
      () => {
        if (this.currentIframeKey === iframeKey && this.currentSessionId === sessionId) {
          this.failStartup(
            `${this.stageLabel()} The editor did not respond within 30 seconds. Retry to reconnect.`,
          );
        }
      },
      Math.max(0, this.startupDeadlineAt - Date.now()),
    );
  }

  private failStartup(message: string): void {
    this.clearReadyTimeout();
    this.isLoading.set(false);
    this.startupIssue.set(message);
    if (this.currentIframeKey) {
      this.stateService.setReady(this.currentIframeKey, false);
      const iframe = this.stateService.getIframe(this.currentIframeKey);
      iframe?.contentWindow?.postMessage(
        {
          type: 'elevenex-editor-cancel',
          generation: this.iframeGeneration,
          requestId: this.probeId,
        },
        new URL(iframe.src).origin,
      );
    }
  }

  canShowEditor(): boolean {
    return this.currentIframeKey !== null;
  }

  showEditor(): void {
    if (this.currentIframeKey) this.stateService.markUserAccess(this.currentIframeKey);
    this.startupIssue.set(null);
  }

  retry(): void {
    // Recovery reuses a live extension (and its unsaved documents). Reload only
    // after the state service has confirmed there are no dirty buffers.
    const key = this.currentIframeKey;
    if (!key) {
      this.forcedSessionId.set(this.sessionId());
      return;
    }
    const version = ++this.recoveryVersion;
    this.isLoading.set(true);
    this.startupIssue.set(null);
    void this.stateService
      .recoverIframe(key)
      .then(() => {
        if (!this.destroyed && this.currentIframeKey === key && this.recoveryVersion === version)
          this.createOrShowIframe(this.sessionId(), this.projectId(), this.worktreePath());
      })
      .catch((error) => {
        if (!this.destroyed && this.currentIframeKey === key && this.recoveryVersion === version)
          this.failStartup(error.message);
      });
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeoutId) clearTimeout(this.readyTimeoutId);
    this.readyTimeoutId = null;
  }

  private requestWorkbenchReady(iframeKey: string): void {
    const iframe = this.stateService.getIframe(iframeKey);
    iframe?.contentWindow?.postMessage(
      {
        type: 'vscode-workbench-check-ready',
        generation: this.iframeGeneration,
        requestId: this.probeId,
      },
      new URL(iframe.src).origin,
    );
  }

  private cleanupAttempt(): void {
    if (this.deferredTimer) clearTimeout(this.deferredTimer);
    this.deferredTimer = undefined;
    this.deferredScope = null;
    this.recoveryVersion++;
    this.clearReadyTimeout();
    this.removeLoadListener?.();
    this.removeLoadListener = undefined;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = undefined;
    this.pendingAutoReveal = null;
    this.probeId = '';
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

      this.pendingAutoReveal = change.path;
    }
    if (this.pendingAutoReveal && !this.revealTimer) {
      this.revealTimer = setTimeout(() => {
        this.revealTimer = undefined;
        const path = this.pendingAutoReveal;
        this.pendingAutoReveal = null;
        if (path && !this.isLoading() && !this.startupIssue()) this.openOrRevealChangedFile(path);
      }, 750);
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
    this.openFile({ path }, true);
  }

  openFile(target: string | LocalFileTarget, preserveFocus = false): void {
    const requestedTarget = typeof target === 'string' ? { path: target } : target;
    const normalizedPath = requestedTarget.path.replace(/^\/+/, '');
    if (!normalizedPath) {
      return;
    }
    const normalizedTarget = { ...requestedTarget, path: normalizedPath };

    if (this.currentIframeKey === null) {
      this.pendingFileToReveal = { target: normalizedTarget, preserveFocus };
      return;
    }

    if (!this.stateService.isReady(this.currentIframeKey)) {
      this.pendingFileToReveal = { target: normalizedTarget, preserveFocus };
      return;
    }

    const iframe = this.stateService.getIframe(this.currentIframeKey);
    if (!iframe?.contentWindow) {
      this.pendingFileToReveal = { target: normalizedTarget, preserveFocus };
      return;
    }

    iframe.contentWindow.postMessage(
      {
        type: 'elevenex-open-file',
        ...normalizedTarget,
        preserveFocus,
        preview: preserveFocus,
        generation: this.iframeGeneration,
      },
      new URL(iframe.src).origin,
    );
  }

  private flushPendingFileReveal(iframeKey: string): void {
    if (!this.pendingFileToReveal || this.currentIframeKey !== iframeKey) {
      return;
    }

    const pending = this.pendingFileToReveal;
    this.pendingFileToReveal = null;
    this.openFile(pending.target, pending.preserveFocus);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.cleanupAttempt();
    window.removeEventListener('message', this.handleWindowMessage);
    this.clearReadyTimeout();
    if (this.currentIframeKey !== null) {
      this.stateService.hideIframe(this.currentIframeKey);
    }
  }
}
