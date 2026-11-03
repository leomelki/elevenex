import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, TemplateRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import type { CodeAction, CodeFileIntent, CodeSurfaceState, CodeTarget } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, ProgressLineComponent } from '../ui';
import { CodeWorkspaceStore } from './code-workspace.store';
@Component({
  selector: 'ex-code-panel', providers: [CodeWorkspaceStore],
  imports: [ButtonComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, ProgressLineComponent],
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
  readonly connected = input(true);
  readonly wide = input(false);
  readonly standalone = input(false);
  readonly wideChange = output<boolean>();
  readonly file = input<CodeFileIntent | null>(null);
  readonly store = inject(CodeWorkspaceStore);
  readonly measuredWidth = signal(0);
  readonly measuredHeight = signal(0);
  readonly covered = signal(false);
  readonly canEmbed = computed(() => this.measuredWidth() >= 320 && this.measuredHeight() >= 160);
  readonly launching = computed(() => this.store.busy() || this.store.state()?.phase === 'loading');
  readonly connectionLost = computed(() => !this.connected() || this.store.state()?.phase === 'disconnected' && !this.store.state()?.relocated && !this.store.state()?.detached);
  readonly hasSurface = computed(() => !!this.store.state() && this.store.state()?.phase !== 'failed' && this.store.state()?.phase !== 'loading' && !this.store.state()?.relocated && !this.store.state()?.detached && this.canEmbed());
  readonly title = computed(() => this.launching() ? 'Opening your workspace' : this.store.error() || this.store.state()?.phase === 'failed' ? 'Code couldn’t open' : !this.target() ? 'Choose a task to open Code' : this.store.state() ? 'Continue in your editor' : 'Your task, in Code');
  readonly modifier = computed(() => this.bridge.platform === 'darwin' ? '⌘' : 'Ctrl+');
  readonly findShortcut = computed(() => this.modifier() + 'P');
  readonly searchShortcut = computed(() => this.bridge.platform === 'darwin' ? '⇧⌘F' : 'Ctrl+Shift+F');
  readonly returnShortcut = computed(() => this.bridge.platform === 'darwin' ? '⇧⌘R' : 'Ctrl+Shift+R');
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly surface = viewChild<ElementRef<HTMLElement>>('surface');
  private consumedFile: CodeFileIntent | null = null;
  private previousWide?: boolean;
  private standaloneOpened = false;
  private readonly placedTarget = signal<CodeTarget | null>(null);
  private readonly focusRequest = signal<CodeTarget | null>(null);
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    const stopExit = this.bridge.onCodeExitRequested?.(target => { if (this.active() && this.target()?.scopeId === target.scopeId && this.target()?.taskId === target.taskId) this.wideChange.emit(false); });
    inject(DestroyRef).onDestroy(() => stopExit?.());
    effect(() => { const target = this.target(), initial = this.initialState(); untracked(() => { this.focusRequest.set(null); this.store.select(target); if (initial) this.store.adopt(initial); }); });
    effect(() => {
      const active = this.active(), wide = this.wide(), target = this.target(), connected = this.connected(), standalone = this.standalone(), fits = this.canEmbed();
      if (active && target && connected) untracked(() => {
        if (this.previousWide === false || standalone && !this.standaloneOpened) this.focusRequest.set(target);
        if (standalone) this.standaloneOpened = true;
        if (fits) void this.store.open();
      });
      this.previousWide = wide;
    });
    effect(() => { const file = this.file(), target = this.target(); if (file && file !== this.consumedFile && target && file.scopeId === target.scopeId && file.taskId === target.taskId && this.active() && this.connected()) untracked(() => { this.consumedFile = file; void this.store.openFile(file.file).then(() => { if (this.file() === file && this.target()?.scopeId === target.scopeId && this.target()?.taskId === target.taskId && !this.store.error()) this.focusRequest.set(target); }); }); });
    effect(() => { if (!this.active()) untracked(() => this.store.suspend()); });
    afterRenderEffect(onCleanup => {
      const element = this.surface()?.nativeElement, target = this.target(), active = this.active(), hasSurface = this.hasSurface();
      if (!element || !target) return;
      let frame = 0, previous = '', stopped = false, placement = 0;
      const measure = () => {
        frame = 0;
        const rect = element.getBoundingClientRect(); this.measuredWidth.set(Math.floor(rect.width)); this.measuredHeight.set(Math.floor(rect.height));
        const blocked = !!this.root.closest('[inert], [hidden]') || Array.from(document.querySelectorAll<HTMLElement>('.cdk-overlay-pane, [role="dialog"]')).some(item => {
          if (!item.getClientRects().length || item.closest('[hidden], [inert]')) return false;
          if (item.matches('[role="dialog"]')) return true;
          const overlay = item.getBoundingClientRect();
          return overlay.left < rect.right && overlay.right > rect.left && overlay.top < rect.bottom && overlay.bottom > rect.top;
        });
        this.covered.set(blocked);
        const bounds = active && hasSurface && !blocked && rect.width >= 320 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        const key = JSON.stringify(bounds);
        if (key !== previous) {
          previous = key; const revision = ++placement; this.placedTarget.set(null);
          void this.bridge.codeLayout?.(target, bounds).then(() => { if (!stopped && bounds && revision === placement) this.placedTarget.set(target); }).catch(() => undefined);
        }
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
      const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule); resize?.observe(element);
      const mutations = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(schedule); mutations?.observe(document.body, { attributes: true, attributeFilter: ['inert', 'hidden', 'class'], childList: true, subtree: true });
      window.addEventListener('resize', schedule); measure();
      onCleanup(() => { stopped = true; this.placedTarget.set(null); if (frame) cancelAnimationFrame(frame); resize?.disconnect(); mutations?.disconnect(); window.removeEventListener('resize', schedule); void this.bridge.codeLayout?.(target, null).catch(() => undefined); });
    });
    afterRenderEffect(() => {
      const wanted = this.focusRequest(), placed = this.placedTarget();
      if (!wanted || !placed || wanted.scopeId !== placed.scopeId || wanted.taskId !== placed.taskId || !this.active() || !this.hasSurface()) return;
      untracked(() => { this.focusRequest.set(null); this.store.focus(); });
    });
    inject(DestroyRef).onDestroy(() => { const target = this.target(); if (target) void this.bridge.codeLayout?.(target, null).catch(() => undefined); });
  }
  expand(): void { this.focusRequest.set(this.target()); this.wideChange.emit(true); void this.store.open(); }
  retry(): void { this.focusRequest.set(this.target()); void this.store.open(); }
  focusEditor(): void { this.focusRequest.set(this.target()); }
  recover(): void { this.focusRequest.set(this.target()); void this.store.recover(); }
  async runAction(action: CodeAction): Promise<void> {
    const target = this.target();
    if (!target || !this.active() || !this.hasSurface() || this.covered()) return;
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
