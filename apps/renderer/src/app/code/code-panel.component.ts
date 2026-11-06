import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, TemplateRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { CodeAction, CodeFileIntent, CodeSurfaceState, CodeTarget } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, ProgressLineComponent } from '../ui';
import { CodeFramePool } from './code-frame-pool.service';
import { CodeWorkspaceStore } from './code-workspace.store';
import { CodeViewportDirective } from './code-viewport.directive';
@Component({
  selector: 'ex-code-panel', providers: [CodeWorkspaceStore],
  imports: [ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, ProgressLineComponent, CodeViewportDirective],
  host: { '[class.wide]': 'wide()', '[attr.aria-busy]': 'launching()' },
  templateUrl: './code-panel.component.html', styleUrl: './code-panel.component.css', changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodePanelComponent {
  /** Project compact editor controls into the existing side-panel navigation. */
  readonly actions = viewChild<TemplateRef<unknown>>('actions');
  readonly target = input<CodeTarget | null>(null);
  readonly initialState = input<CodeSurfaceState | null>(null);
  readonly taskName = input('');
  readonly branch = input('');
  readonly active = input(false);
  /** Retain the picture through the shell's inert closing slide. */
  readonly retained = input(false);
  readonly frameVisible = computed(() => this.active() || this.retained());
  readonly connected = input(true);
  readonly wide = input(false);
  readonly standalone = input(false);
  readonly wideChange = output<boolean>();
  readonly file = input<CodeFileIntent | null>(null);
  readonly store = inject(CodeWorkspaceStore);
  readonly measuredWidth = signal(0);
  readonly compact = computed(() => this.measuredWidth() < 600);
  readonly layoutRevision = signal(0);
  private readonly acknowledgedLayout = signal(-1);
  readonly layoutReady = computed(() => this.acknowledgedLayout() === this.layoutRevision());
  readonly viewportKey = computed(() => { const target = this.target(); return this.frameVisible() && target ? `${target.scopeId}:${target.taskId}` : ''; });
  readonly launching = computed(() => this.store.busy() || this.store.state()?.phase === 'loading' || this.showFrame() && this.frameLoading());
  readonly connectionLost = computed(() => !this.connected() || this.store.state()?.phase === 'disconnected' && !this.store.state()?.relocated && !this.store.state()?.detached);
  readonly showFrame = computed(() => !!this.frameResource() && this.store.state()?.phase !== 'failed');
  readonly hasSurface = computed(() => this.showFrame() && this.store.state()?.phase !== 'loading');
  private readonly presentedFrame = signal<string | null>(null);
  readonly frameLoading = computed(() => this.store.state()?.phase === 'loading' || this.presentedFrame() !== this.frameResource());
  readonly title = computed(() => this.launching() ? 'Opening your workspace' : this.store.error() || this.store.state()?.phase === 'failed' ? 'Code couldn’t open' : !this.target() ? 'Choose a task to open Code' : this.store.state() ? 'Continue in your editor' : 'Your task, in Code');
  readonly modifier = computed(() => this.bridge.platform === 'darwin' ? '⌘' : 'Ctrl+');
  readonly browsing = computed(() => this.compact() && this.store.state()?.filesOpen === true && this.store.state()?.hasEditors === true);
  readonly browseLabel = computed(() => this.browsing() ? 'Back to editor · Esc' : this.bridge.platform === 'darwin' ? 'Browse files · ⇧⌘E' : 'Browse files · Ctrl+Shift+E');
  readonly findShortcut = computed(() => this.modifier() + 'P');
  readonly searchShortcut = computed(() => this.bridge.platform === 'darwin' ? '⇧⌘F' : 'Ctrl+Shift+F');
  readonly returnShortcut = computed(() => this.bridge.platform === 'darwin' ? '⇧⌘R' : 'Ctrl+Shift+R');
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly frames = inject(CodeFramePool);
  private readonly frameResource = computed(() => {
    const state = this.store.state();
    return state && !state.relocated && !state.detached ? state.frameUrl ?? null : null;
  });
  private readonly frameContainer = viewChild<ElementRef<HTMLElement>>('frameContainer');
  private consumedFile: CodeFileIntent | null = null;
  private previousWide?: boolean;
  private openingSelection: CodeTarget | null = null;
  private standaloneOpened = false;
  private readonly placedTarget = signal<CodeTarget | null>(null);
  private readonly focusRequest = signal<CodeTarget | null>(null);
  constructor() {
    const stopExit = this.bridge.onCodeExitRequested?.(target => { if (this.active() && this.target()?.scopeId === target.scopeId && this.target()?.taskId === target.taskId) this.wideChange.emit(false); });
    inject(DestroyRef).onDestroy(() => stopExit?.());
    effect(() => { const target = this.target(), initial = this.initialState(); untracked(() => { this.focusRequest.set(null); this.store.select(target); if (initial) this.store.adopt(initial); }); });
    effect(() => {
      const active = this.active(), wide = this.wide(), target = this.target(), connected = this.connected(), standalone = this.standalone();
      if (active && target && connected) untracked(() => {
        if (this.previousWide === false || standalone && !this.standaloneOpened) this.focusRequest.set(target);
        if (standalone) this.standaloneOpened = true;
        if (this.openingSelection?.scopeId !== target.scopeId || this.openingSelection.taskId !== target.taskId) { this.openingSelection = target; void this.store.open(); }
      });
      if (!active || !connected || !target) this.openingSelection = null;
      this.previousWide = wide;
    });
    effect(() => { const file = this.file(), target = this.target(); if (file && file !== this.consumedFile && target && file.scopeId === target.scopeId && file.taskId === target.taskId && this.active() && this.connected()) untracked(() => { this.consumedFile = file; void this.store.openFile(file.file).then(() => { if (this.file() === file && this.target()?.scopeId === target.scopeId && this.target()?.taskId === target.taskId && !this.store.error()) this.focusRequest.set(target); }); }); });
    effect(() => { if (!this.active()) untracked(() => this.store.suspend()); });
    afterRenderEffect(onCleanup => {
      const container = this.frameContainer()?.nativeElement, url = this.frameResource();
      if (!container || !url || !this.frameVisible()) return;
      onCleanup(this.frames.mount(url, container));
    });
    afterRenderEffect(onCleanup => {
      const target = this.target(), active = this.active(), hasSurface = this.hasSurface();
      const compact = this.compact();
      const revision = this.layoutRevision();
      if (!target) return;
      let stopped = false;
      // CSS owns layout. Inform main only about visibility and the compact-mode
      // boundary, never every pixel/frame of panel animation.
      const visible = active && hasSurface;
      if (!hasSurface) this.presentedFrame.set(null);
      const frame = this.frameResource();
      this.placedTarget.set(null);
      this.acknowledgedLayout.set(-1);
      const viewportWidth = revision > 0 && visible ? untracked(() => this.measuredWidth()) : 0;
      void this.bridge.codePresent?.(target, { visible, compact, ...(viewportWidth > 0 ? { viewportWidth } : {}) }).then(() => {
        if (stopped) return;
        this.acknowledgedLayout.set(revision);
        if (visible) { this.presentedFrame.set(frame); this.placedTarget.set(target); }
      }).catch(() => {
        if (!stopped) {
          // A failed barrier must not leave retained writing permanently hidden.
          this.store.error.set('The editor could not finish resizing. Your edits are retained.');
          this.acknowledgedLayout.set(revision);
          if (visible) this.presentedFrame.set(frame);
        }
      });
      onCleanup(() => { stopped = true; });
    });
    afterRenderEffect(() => {
      const wanted = this.focusRequest(), placed = this.placedTarget();
      if (!wanted || !placed || wanted.scopeId !== placed.scopeId || wanted.taskId !== placed.taskId || !this.active() || !this.hasSurface()) return;
      untracked(() => { this.focusRequest.set(null); this.store.focus(); });
    });
    inject(DestroyRef).onDestroy(() => { const target = this.target(); if (target) void this.bridge.codePresent?.(target, {visible:false, compact:this.compact()}).catch(() => undefined); });
  }
  retry(): void { this.focusRequest.set(this.target()); void this.store.open(); }
  focusEditor(): void { this.focusRequest.set(this.target()); }
  recover(): void { this.focusRequest.set(this.target()); void this.store.recover(); }
  async runAction(action: CodeAction): Promise<void> {
    const target = this.target();
    if (!target || !this.active() || !this.hasSurface()) return;
    try { await this.bridge.codeAction(target, action); }
    catch { if (this.target()?.scopeId === target.scopeId && this.target()?.taskId === target.taskId) this.store.error.set('The editor action could not complete. Your edits are retained.'); }
  }
  dismissError(): void { this.store.error.set(''); this.focusEditor(); }
  async detach(): Promise<void> {
    const target = this.target();
    if (this.store.state()?.relocated) await this.store.recover();
    if (target && target.scopeId === this.target()?.scopeId && target.taskId === this.target()?.taskId && !this.store.error()) await this.store.detach();
  }
}
