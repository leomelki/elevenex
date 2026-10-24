import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeService } from '@/shared/services/theme.service';
import { VSCodeWebStateService } from '../vscode-web-state.service';
import { VSCodeWebPanelComponent } from './vscode-web-panel.component';

describe('VSCodeWebPanelComponent lifecycle', () => {
  let fixture: ComponentFixture<VSCodeWebPanelComponent>;
  let frames: Map<string, HTMLIFrameElement>;
  let ready: Map<string, boolean>;
  let state: any;
  beforeEach(async () => {
    vi.useFakeTimers();
    frames = new Map();
    ready = new Map();
    state = {
      hasIframe: vi.fn((key: string) => frames.has(key)),
      getIframe: vi.fn((key: string) => frames.get(key)),
      hideIframe: vi.fn(),
      setTheme: vi.fn(),
      isReady: (key: string) => ready.get(key) || false,
      setReady: (key: string, value: boolean) => ready.set(key, value),
      recoverIframe: vi.fn(async () => undefined),
      getOrCreateIframe: vi.fn((key: string, _path: string, container: HTMLElement) => {
        if (frames.has(key)) return frames.get(key);
        const iframe = document.createElement('iframe');
        iframe.src = `http://localhost/editor?generation=${encodeURIComponent(key)}`;
        container.appendChild(iframe);
        frames.set(key, iframe);
        return iframe;
      }),
    };
    await TestBed.configureTestingModule({
      imports: [VSCodeWebPanelComponent],
      providers: [
        { provide: VSCodeWebStateService, useValue: state },
        { provide: ThemeService, useValue: { isDark: signal(false) } },
      ],
    }).compileComponents();
  });
  afterEach(() => {
    fixture?.destroy();
    vi.useRealTimers();
  });

  function setup(allowed = true) {
    fixture = TestBed.createComponent(VSCodeWebPanelComponent);
    fixture.componentRef.setInput('sessionId', 7);
    fixture.componentRef.setInput('projectId', 1);
    fixture.componentRef.setInput('taskId', 42);
    fixture.componentRef.setInput('worktreePath', '/worktree');
    fixture.componentRef.setInput('startupAllowed', allowed);
    fixture.detectChanges();
    return fixture.componentInstance as any;
  }
  function message(panel: any, data: any, overrides = {}) {
    const iframe = frames.get(panel.currentIframeKey)!;
    panel.handleWindowMessage({
      source: iframe.contentWindow,
      origin: new URL(iframe.src).origin,
      data: { generation: panel.iframeGeneration, requestId: panel.probeId, ...data },
      ...overrides,
    });
  }
  function usable(panel: any) {
    message(panel, { type: 'vscode-workbench-ready', bridgeReady: true, workspaceReady: true });
  }

  it('defers a cold editor until chat startup is allowed', () => {
    setup(false);
    expect(state.getOrCreateIframe).not.toHaveBeenCalled();
    fixture.componentRef.setInput('startupAllowed', true);
    fixture.detectChanges();
    expect(state.getOrCreateIframe).toHaveBeenCalledTimes(1);
  });
  it('requires extension and usable workspace readiness after the DOM stage', () => {
    const panel = setup();
    message(panel, { type: 'elevenex-editor-stage', stage: 'workbench' });
    message(panel, { type: 'vscode-workbench-ready' });
    expect(panel.isLoading()).toBe(true);
    usable(panel);
    expect(panel.isLoading()).toBe(false);
    expect(panel.startupIssue()).toBeNull();
  });
  it.each(['navigation', 'workbench', 'bridge'])(
    'settles a stalled %s in a finite error/retry state',
    async (stage) => {
      const panel = setup();
      if (stage !== 'navigation') message(panel, { type: 'elevenex-editor-stage', stage });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(panel.isLoading()).toBe(false);
      expect(panel.startupIssue()).toContain('30 seconds');
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Retry connection');
      usable(panel); // A late completion cannot dismiss an error or restart work.
      expect(panel.startupIssue()).toBeTruthy();
    },
  );
  it.each(['elevenex-editor-startup-error', 'elevenex-editor-sync-error'])(
    'settles %s and allows a clean retry',
    async (type) => {
      const panel = setup();
      message(panel, { type, message: 'Connection failed' });
      expect(panel.isLoading()).toBe(false);
      expect(panel.startupIssue()).toBe('Connection failed');
      const previous = panel.probeId;
      panel.retry();
      await Promise.resolve();
      expect(state.recoverIframe).toHaveBeenCalledTimes(1);
      expect(panel.probeId).not.toBe(previous);
      usable(panel);
      expect(panel.isLoading()).toBe(false);
      expect(panel.startupIssue()).toBeNull();
    },
  );
  it('ignores stale generations, probes, origins, and frames', () => {
    const panel = setup();
    for (const override of [{ generation: 'old' }, { requestId: 'old' }]) {
      message(panel, {
        type: 'vscode-workbench-ready',
        bridgeReady: true,
        workspaceReady: true,
        ...override,
      });
    }
    message(
      panel,
      { type: 'vscode-workbench-ready', bridgeReady: true, workspaceReady: true },
      { origin: 'http://wrong' },
    );
    expect(panel.isLoading()).toBe(true);
    usable(panel);
    expect(panel.isLoading()).toBe(false);
  });
  it('clears queued opens and ignores a retry completing after a task switch', async () => {
    const panel = setup();
    let finish!: () => void;
    state.recoverIframe.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    panel.openFile('old.txt');
    panel.retry();
    fixture.componentRef.setInput('taskId', 43);
    fixture.detectChanges();
    const current = panel.probeId;
    finish();
    await Promise.resolve();
    expect(panel.probeId).toBe(current);
    expect(panel.pendingFileToReveal).toBeNull();
  });
  it('restarts the handshake on iframe reload and removes the listener on unmount', async () => {
    const panel = setup();
    usable(panel);
    const iframe = frames.get(panel.currentIframeKey)!;
    iframe.dispatchEvent(new Event('load'));
    expect(panel.isLoading()).toBe(true);
    fixture.destroy();
    iframe.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(panel.startupIssue()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('coalesces thousands of edits to one preview and keeps explicit file positions', async () => {
    const panel = setup();
    usable(panel);
    const iframe = frames.get(panel.currentIframeKey)!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
    post.mockClear();
    message(panel, {
      type: 'elevenex-editor-file-changes',
      changes: Array.from({ length: 5000 }, (_, i) => ({ event: 'change', path: `${i}.ts` })),
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({
      path: '4999.ts',
      preview: true,
      preserveFocus: true,
    });
    panel.openFile({ path: 'notes.md', rootPath: '/tmp', line: 12, column: 3 });
    expect(post.mock.calls[1][0]).toMatchObject({
      path: 'notes.md',
      rootPath: '/tmp',
      line: 12,
      column: 3,
      preview: false,
    });
  });
  it('does not extend the startup deadline indefinitely across repeated iframe reloads', async () => {
    const panel = setup();
    const iframe = frames.get(panel.currentIframeKey)!;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      iframe.dispatchEvent(new Event('load'));
    }
    expect(panel.isLoading()).toBe(false);
    expect(panel.startupIssue()).toBeTruthy();
  });
  it('settles deferred session setup and lets retry start the editor directly', async () => {
    const panel = setup(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(panel.isLoading()).toBe(false);
    expect(panel.startupIssue()).toContain('Session setup');
    panel.retry();
    fixture.detectChanges();
    expect(state.getOrCreateIframe).toHaveBeenCalledTimes(1);
    usable(panel);
    expect(panel.isLoading()).toBe(false);
    expect(panel.startupIssue()).toBeNull();
  });
});
