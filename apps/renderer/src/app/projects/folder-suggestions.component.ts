import { CdkConnectedOverlay, OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, effect, inject, input, linkedSignal, model, output, signal, viewChild } from '@angular/core';
import { AutoHeightDirective, ButtonComponent, FittedHighlightDirective, IconComponent, KbdComponent, SkeletonComponent, StatusGlyphComponent } from '../ui';
import { folderName } from './project-face';
import type { FolderEntry, FolderProvider } from './project.models';
import { FolderOverlayPosition } from './folder-overlay-position';
import { completedFolderPath, FolderSuggestionsSource } from './folder-suggestions-source';

/** A supplied, bounded one-level folder picker. It never reads the filesystem. */
@Component({
  selector: 'ex-folder-suggestions',
  imports: [OverlayModule, AutoHeightDirective, ButtonComponent, FittedHighlightDirective, IconComponent, KbdComponent, SkeletonComponent, StatusGlyphComponent],
  templateUrl: './folder-suggestions.component.html',
  styleUrl: './folder-suggestions.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderSuggestionsComponent {
  readonly query = model('');
  readonly machine = input('this machine');
  readonly listFolders = input<FolderProvider>();
  readonly addedPaths = input<readonly string[]>([]);
  readonly listOpen = input(false);
  readonly autoFocus = input(false);
  /** Lets an owning modal's focus trap choose this field without another autofocus owner. */
  readonly initialFocus = input(false);
  readonly active = input(true);
  readonly disabled = input(false);
  readonly selected = output<FolderEntry>();
  readonly continued = output<void>();
  readonly inputElement = viewChild<ElementRef<HTMLInputElement>>('field');
  protected readonly id = `folders-${crypto.randomUUID()}`;
  protected readonly focused = linkedSignal(() => this.listOpen());
  protected readonly composing = signal(false);
  private readonly activePath = signal<string | null>(null);
  protected readonly enabled = computed(() => this.active() && !this.disabled());
  protected readonly source = new FolderSuggestionsSource({ query: this.query, provider: this.listFolders, active: this.enabled, composing: this.composing });
  protected readonly items = this.source.items;
  protected readonly highlighted = computed(() => {
    const entries = this.items(), added = this.addedPaths(), path = this.activePath();
    const index = entries.findIndex(entry => entry.path === path && !added.includes(entry.path));
    return index >= 0 ? index : entries.findIndex(entry => !added.includes(entry.path));
  });
  protected readonly selectionKey = computed(() => this.items().map(entry => entry.path).join('\n') + ':' + this.highlighted());
  protected readonly open = computed(() => this.enabled() && !this.composing() && this.focused() && !!this.query() && !!this.listFolders());
  protected readonly url = computed(() => /^(git@|https?:\/\/|ssh:\/\/)/i.test(this.query()));
  protected readonly positions: ConnectedPosition[] = [{ originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetX: -1, offsetY: 6 }];
  protected readonly name = folderName;
  private readonly destroy = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly overlay = viewChild(CdkConnectedOverlay);
  private pendingIntent: { readonly query: string; readonly action: 'browse' | 'select' } | null = null;
  private position?: FolderOverlayPosition;

  constructor() {
    afterNextRender(() => { if (this.autoFocus()) this.focus(); });
    this.destroy.onDestroy(() => this.stopFollowing());
    effect(() => {
      const ready = this.source.ready(), failed = this.source.error(), enabled = this.enabled(), query = this.query();
      const pending = this.pendingIntent;
      if (!enabled || !this.focused() || pending?.query !== query) { this.pendingIntent = null; return; }
      if (!ready && !failed) return;
      this.pendingIntent = null;
      const entry = this.items()[this.highlighted()];
      if (!failed && entry) {
        if (pending.action === 'browse') this.complete(entry);
        else this.pick(entry);
      }
    });
    afterRenderEffect(() => {
      const index = this.highlighted();
      if (!this.open() || index < 0) return;
      const option = this.host.ownerDocument.getElementById(`${this.id}-${index}`);
      const viewport = this.host.ownerDocument.getElementById(this.id)?.closest<HTMLElement>('.options-viewport');
      // Scroll only the suggestions, never the modal or the person's text caret.
      if (option && viewport) {
        if (option.offsetTop < viewport.scrollTop) viewport.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = option.offsetTop + option.offsetHeight - viewport.clientHeight;
      }
    });
  }

  focus(): void { this.inputElement()?.nativeElement.focus(); }
  protected overlayAttached(): void {
    this.stopFollowing();
    const origin = this.host.querySelector<HTMLElement>('.field');
    const overlay = this.overlay()?.overlayRef;
    if (origin && overlay && this.open() && !this.destroy.destroyed) this.position = new FolderOverlayPosition(origin, overlay, this.positions);
  }
  protected stopFollowing(): void { this.position?.dispose(); this.position = undefined; }
  protected blur(): void { this.focused.set(false); this.pendingIntent = null; }
  protected reopen(): void { if (this.enabled()) { this.pendingIntent = null; this.focused.set(true); } }
  protected setQuery(event: Event): void {
    this.pendingIntent = null;
    if (event.target instanceof HTMLInputElement) this.query.set(event.target.value);
    this.focused.set(true);
  }
  protected compositionStarted(): void { this.composing.set(true); this.pendingIntent = null; }
  protected compositionEnded(event: CompositionEvent): void { this.setQuery(event); this.composing.set(false); }
  protected highlight(entry: FolderEntry): void { if (!this.addedPaths().includes(entry.path)) this.activePath.set(entry.path); }
  protected pick(entry: FolderEntry): void {
    if (!this.enabled() || this.composing() || this.addedPaths().includes(entry.path) || !this.items().some(item => item.path === entry.path)) return;
    this.pendingIntent = null;
    this.selected.emit(entry);
    this.focus();
  }
  private complete(entry: FolderEntry): void {
    if (entry.clone || this.addedPaths().includes(entry.path)) return;
    const path = completedFolderPath(this.query(), entry);
    this.pendingIntent = null; this.activePath.set(null); this.query.set(path);
    const field = this.inputElement()?.nativeElement;
    if (field) {
      field.value = path;
      field.setSelectionRange(path.length, path.length);
      field.scrollLeft = field.scrollWidth;
    }
  }
  protected retry(): void { if (this.enabled()) this.source.retry(); }
  protected keydown(event: KeyboardEvent): void {
    if (!this.enabled() || event.isComposing || this.composing()) return;
    const entries = this.items(), entry = this.open() ? entries[this.highlighted()] : undefined;
    if (event.key !== 'Tab' && event.key !== 'Enter') this.pendingIntent = null;
    if (event.key === 'Escape' && this.open()) {
      event.preventDefault(); event.stopPropagation(); this.blur();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); this.reopen();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      for (let offset = 1; offset <= entries.length; offset++) {
        const index = (this.highlighted() + direction * offset + entries.length) % entries.length;
        const candidate = entries[index];
        if (candidate && !this.addedPaths().includes(candidate.path)) { this.activePath.set(candidate.path); break; }
      }
    } else if (event.key === 'Tab' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && this.open() && !this.url()) {
      const field = this.inputElement()?.nativeElement;
      if (field && (field.selectionStart !== field.selectionEnd || field.selectionEnd !== field.value.length)) return;
      if (entry && !entry.clone && this.query() !== completedFolderPath(this.query(), entry)) {
        event.preventDefault(); event.stopPropagation(); this.complete(entry);
      } else if (this.source.pending()) {
        event.preventDefault(); event.stopPropagation(); this.pendingIntent = { query: this.query(), action: 'browse' };
      }
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); event.stopPropagation();
      if (!this.query()) this.continued.emit();
      else if (entry) this.pick(entry);
      else if (this.source.error()) this.retry();
      else {
        this.reopen();
        if (this.source.pending()) this.pendingIntent = { query: this.query(), action: 'select' };
      }
    }
  }
}
