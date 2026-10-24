import { CdkConnectedOverlay, OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, PendingTasks, afterNextRender, computed, effect, inject, input, linkedSignal, model, output, signal, viewChild } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { folderName } from './project-face';
import type { FolderEntry, FolderProvider } from './project.models';
import { FolderOverlayPosition } from './folder-overlay-position';

/** A supplied, bounded one-level folder picker. It never reads the filesystem. */
@Component({
  selector: 'ex-folder-suggestions',
  imports: [OverlayModule, IconComponent, KbdComponent],
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
  readonly active = input(true);
  readonly disabled = input(false);
  readonly selected = output<FolderEntry>();
  readonly continued = output<void>();
  readonly inputElement = viewChild<ElementRef<HTMLInputElement>>('field');
  protected readonly id = `folders-${crypto.randomUUID()}`;
  protected readonly focused = linkedSignal(() => this.listOpen());
  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly items = signal<readonly FolderEntry[]>([]);
  protected readonly highlighted = signal(0);
  protected readonly open = computed(() => this.active() && !this.disabled() && this.focused() && !!this.query() && (this.loading() || this.error() || this.items().length > 0));
  protected readonly url = computed(() => /^(git@|https?:\/\/)/.test(this.query()));
  protected readonly positions: ConnectedPosition[] = [{ originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetX: -1, offsetY: 6 }];
  protected readonly name = folderName;
  private readonly destroy = inject(DestroyRef);
  private readonly pendingTasks = inject(PendingTasks);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly overlay = viewChild(CdkConnectedOverlay);
  private position?: FolderOverlayPosition;

  constructor() {
    afterNextRender(() => { if (this.autoFocus()) this.focus(); });
    this.destroy.onDestroy(() => this.stopFollowing());
    effect((onCleanup) => {
      const query = this.query();
      const provider = this.listFolders();
      const active = this.active() && !this.disabled();
      const controller = new AbortController();
      let current = true;
      const finishPending = query && provider && active ? this.pendingTasks.add() : undefined;
      onCleanup(() => { current = false; controller.abort(); finishPending?.(); });
      this.highlighted.set(0);
      this.items.set([]);
      this.error.set(false);
      if (!query || !provider || !active) { this.loading.set(false); return; }
      this.loading.set(true);
      // Promise.resolve also handles a synchronous provider; capture synchronous errors.
      Promise.resolve().then(() => provider(query, controller.signal)).then(entries => {
        if (!current || controller.signal.aborted || this.destroy.destroyed) return;
        const seen = new Set<string>();
        const visible: FolderEntry[] = [];
        for (const entry of entries) {
          if (!entry.path || seen.has(entry.path)) continue;
          seen.add(entry.path);
          visible.push(entry);
          if (visible.length === 50) break;
        }
        this.items.set(visible);
        this.loading.set(false);
        finishPending?.();
      }, () => {
        if (!current || controller.signal.aborted || this.destroy.destroyed) return;
        this.loading.set(false);
        this.error.set(true);
        finishPending?.();
      });
    });
  }

  focus(): void { this.inputElement()?.nativeElement.focus(); }
  protected overlayAttached(): void {
    this.stopFollowing();
    const origin = this.host.querySelector<HTMLElement>('.field');
    const overlay = this.overlay()?.overlayRef;
    if (origin && overlay && this.open() && !this.destroy.destroyed) this.position = new FolderOverlayPosition(origin, overlay, this.positions);
  }
  protected stopFollowing(): void {
    this.position?.dispose();
    this.position = undefined;
  }
  protected setQuery(event: Event): void {
    if (event.target instanceof HTMLInputElement) this.query.set(event.target.value);
    this.focused.set(true);
  }
  protected pick(entry: FolderEntry): void {
    if (this.addedPaths().includes(entry.path)) return;
    if (entry.dir && !entry.git && !entry.clone) {
      this.query.set(entry.path.replace(/\/?$/, '/'));
      this.highlighted.set(0);
    } else this.selected.emit(entry);
    this.focus();
  }
  protected keydown(event: KeyboardEvent): void {
    const entries = this.items();
    const highlighted = entries[this.highlighted()];
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && entries.length) {
      event.preventDefault();
      this.focused.set(true);
      this.highlighted.set((this.highlighted() + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length);
    } else if (event.key === 'Tab' && !event.shiftKey && highlighted && this.query() !== highlighted.path) {
      event.preventDefault();
      this.query.set(highlighted.path + (highlighted.dir && !highlighted.git ? '/' : ''));
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      if (!this.query()) this.continued.emit();
      else if (highlighted) this.pick(highlighted);
    }
  }
}
