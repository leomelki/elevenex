import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, effect, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { ButtonComponent } from '../../ui/button/button.component';
import { IconComponent } from '../../ui/icon/icon.component';
import { KbdComponent } from '../../ui/controls/kbd.component';
import type { FolderEntry, FolderProvider } from '../project.models';

@Component({ selector: 'ex-add-project-repository', imports: [ButtonComponent, IconComponent, KbdComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.inert]': 'active() ? null : ""' },
  templateUrl: './add-project-repository.component.html', styleUrl: './add-project-repository.component.css' })
export class AddProjectRepositoryComponent {
  readonly active = input(true);
  readonly adding = input(false);
  readonly machine = input('this machine');
  readonly query = input('~/code/');
  readonly listFolders = input<FolderProvider>();
  readonly listId = input.required<string>();
  readonly context = input<string>();
  readonly started = output<void>();
  readonly cancelled = output<void>();
  readonly added = output<FolderEntry>();
  protected readonly draft = linkedSignal({
    source: () => ({ query: this.query(), active: this.active() }),
    computation: (context, previous): string => context.active ? context.query : previous?.value ?? context.query,
  });
  protected readonly isUrl = computed(() => /^(git@|https?:)/.test(this.draft()));
  protected readonly entries = signal<readonly FolderEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly highlight = signal(0);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private focusWas = false;

  constructor() {
    effect(cleanup => {
      if (!this.active()) return;
      const query = this.draft();
      const list = this.listFolders();
      const adding = this.adding();
      this.context();
      this.highlight.set(0);
      this.entries.set([]);
      this.failed.set(false);
      if (!adding || !list) { this.loading.set(false); return; }
      const controller = new AbortController();
      cleanup(() => controller.abort());
      this.loading.set(true);
      void Promise.resolve().then(() => list(query, controller.signal)).then(entries => {
        if (controller.signal.aborted || !this.active()) return;
        this.entries.set(entries.slice(0, 50));
        this.loading.set(false);
      }, () => {
        if (controller.signal.aborted || !this.active()) return;
        this.loading.set(false);
        this.failed.set(true);
      });
    });
    afterRenderEffect(() => {
      const adding = this.adding();
      const active = this.active();
      const input = this.field()?.nativeElement;
      if (active && adding && !this.focusWas && input) { input.focus(); this.focusWas = true; }
      if (!active || !adding) this.focusWas = false;
    });
  }

  protected choose(entry: FolderEntry, descend = true): void {
    if (!this.active()) return;
    if (descend && entry.dir && !entry.git && !entry.clone) { this.draft.set(entry.path.replace(/\/$/, '') + '/'); return; }
    this.added.emit(entry);
  }
  protected add(): void { const entry = this.entries()[this.highlight()]; if (entry && !this.loading()) this.choose(entry, false); }
  protected start(): void { if (this.active()) this.started.emit(); }
  protected key(event: KeyboardEvent): void {
    if (!this.active()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancelled.emit(); return; }
    const entries = this.entries();
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      const entry = entries[this.highlight()];
      if (entry && !this.loading()) this.choose(entry);
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    if (!entries.length) return;
    event.preventDefault();
    this.highlight.set(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (this.highlight() + delta + entries.length) % entries.length);
  }
}
