import { A11yModule } from '@angular/cdk/a11y';
import { OverlayModule } from '@angular/cdk/overlay';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild, viewChildren } from '@angular/core';
import { ButtonComponent, IconComponent, IconButtonComponent } from '../ui';
import { ChangeListComponent } from './change-list.component';
import { DiffFileComponent } from './diff-file.component';
import { ChangeFile, DiffComment, DiffContextRequest, DiffFileContent, DiffFileRequest, ReviewMode, fileName } from './view.models';

interface ReadingAnchor { readonly fileId: string; readonly lineId?: string; readonly offset: number }

@Component({
  selector: 'ex-diff-review',
  imports: [A11yModule, OverlayModule, ButtonComponent, IconComponent, IconButtonComponent, ChangeListComponent, DiffFileComponent],
  templateUrl: './diff-review.component.html',
  styleUrl: './diff-review.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffReviewComponent {
  readonly files = input<readonly ChangeFile[]>([]);
  readonly contents = input<readonly DiffFileContent[]>([]);
  readonly activeFileId = input<string>();
  readonly mode = input<ReviewMode>('changes');
  readonly wide = input(false);
  readonly wrap = input(true);
  readonly commentsEnabled = input(true);
  readonly largeAt = input(400);
  readonly fileSelected = output<string>();
  readonly modeChange = output<ReviewMode>();
  readonly wrapChange = output<boolean>();
  readonly wideChange = output<boolean>();
  readonly viewedChange = output<{ fileId: string; rev?: string | number; viewed: boolean }>();
  readonly fileRequested = output<DiffFileRequest>();
  readonly contextRequested = output<DiffContextRequest>();
  readonly commented = output<DiffComment>();
  readonly openFileRequested = output<string>();
  readonly exitRequested = output<void>();
  protected readonly names = fileName;
  protected readonly listOpen = signal(false);
  private readonly localSelected = signal<string | undefined>(undefined);
  protected readonly current = computed(() => this.files().find(file => file.id === (this.activeFileId() ?? this.localSelected())) ?? this.files()[0]);
  protected readonly selectedIndex = computed(() => Math.max(0, this.files().findIndex(file => file.id === this.current()?.id)));
  protected readonly pageStart = computed(() => Math.floor(this.selectedIndex() / 12) * 12);
  protected readonly visibleFiles = computed(() => this.files().slice(this.pageStart(), this.pageStart() + 12));
  protected readonly viewedCount = computed(() => this.files().filter(file => file.viewed && !file.changedSinceViewed).length);
  protected readonly contentMap = computed(() => {
    const mode = this.mode();
    const revisions = new Map(this.files().map(file => [file.id, file.rev]));
    const current = new Map<string, DiffFileContent>();
    for (const content of this.contents()) {
      if (content.mode === mode && revisions.has(content.fileId) && revisions.get(content.fileId) === content.rev) current.set(content.fileId, content);
    }
    return current;
  });
  protected readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  protected readonly fileElements = viewChildren<ElementRef<HTMLElement>>('fileCard');
  private readonly requested = new Map<string, string>();
  private observer?: IntersectionObserver;
  private observed: readonly HTMLElement[] = [];
  private targetId?: string;
  private scrollFrame?: number;
  private anchor?: ReadingAnchor;
  private previousContents?: readonly DiffFileContent[];
  private previousMode?: ReviewMode;
  private previousWrap?: boolean;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.observer?.disconnect(); if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame); });
    afterRenderEffect(() => {
      const root = this.scroller()?.nativeElement;
      const elements = this.fileElements().map(reference => reference.nativeElement);
      const mode = this.mode();
      const visible = this.visibleFiles();
      const contents = this.contents();
      const wrap = this.wrap();
      const ids = new Set(this.files().map(file => file.id));
      for (const id of this.requested.keys()) if (!ids.has(id)) this.requested.delete(id);
      if (!root) return;
      if (elements.length !== this.observed.length || elements.some((element, index) => element !== this.observed[index])) {
        this.observer?.disconnect();
        this.observed = elements;
        this.observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const id = (entry.target as HTMLElement).dataset['fileId'];
            const file = this.files().find(item => item.id === id);
            if (file) this.requestVisible(file);
          }
        }, { root, rootMargin: '100% 0px' });
        elements.forEach(element => this.observer?.observe(element));
      }
      // Refresh visible requests on a revision or mode change without recreating the observer.
      for (const element of elements) {
        const rectangle = element.getBoundingClientRect();
        const bounds = root.getBoundingClientRect();
        if (rectangle.top < bounds.bottom + bounds.height && rectangle.bottom > bounds.top - bounds.height) {
          const file = visible.find(item => item.id === element.dataset['fileId']);
          if (file) this.requestVisible(file, mode);
        }
      }
      if (this.targetId) {
        const target = elements.find(element => element.dataset['fileId'] === this.targetId);
        if (target) this.align(target);
        this.targetId = undefined;
      } else if (this.previousContents !== contents || this.previousMode !== mode || this.previousWrap !== wrap) {
        this.restoreAnchor();
      }
      this.previousContents = contents;
      this.previousMode = mode;
      this.previousWrap = wrap;
      this.captureAnchor();
    });
  }

  /** Public navigation by stable identity, also usable by chips in the owning chat. */
  goTo(fileId: string): void {
    const file = this.files().find(item => item.id === fileId);
    if (!file) return;
    this.targetId = fileId;
    this.localSelected.set(fileId);
    this.fileSelected.emit(fileId);
    this.listOpen.set(false);
    this.requestVisible(file, this.mode(), 'selected');
    const existing = this.fileElements().find(element => element.nativeElement.dataset['fileId'] === fileId)?.nativeElement;
    if (existing) { this.align(existing); this.targetId = undefined; }
  }

  protected step(direction: 1 | -1): void {
    const file = this.files()[this.selectedIndex() + direction];
    if (file) this.goTo(file.id);
  }
  protected setPage(direction: 1 | -1): void {
    const file = this.files()[this.pageStart() + direction * 12];
    if (file) this.goTo(file.id);
  }
  protected setMode(mode: ReviewMode): void { if (mode !== this.mode()) { this.captureAnchor(); this.modeChange.emit(mode); } }
  protected toggleWrap(): void { this.captureAnchor(); this.wrapChange.emit(!this.wrap()); }
  protected requestContext(request: DiffContextRequest): void { this.captureAnchor(); this.contextRequested.emit(request); }
  protected viewFile(event: { fileId: string; rev?: string | number; viewed: boolean }): void {
    if (event.viewed) {
      const element = this.fileElements().find(reference => reference.nativeElement.dataset['fileId'] === event.fileId)?.nativeElement;
      const root = this.scroller()?.nativeElement;
      // Put the sticky header at its natural position before its long body folds away.
      if (element && root && element.getBoundingClientRect().top < root.getBoundingClientRect().top) this.align(element);
    }
    this.captureAnchor();
    this.viewedChange.emit(event);
  }
  private align(element: HTMLElement, inset = 0): void {
    const root = this.scroller()?.nativeElement;
    if (root) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - inset;
  }
  private captureAnchor(): void {
    const root = this.scroller()?.nativeElement;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const file = this.fileElements().find(reference => reference.nativeElement.getBoundingClientRect().bottom > top + 40)?.nativeElement;
    const fileId = file?.dataset['fileId'];
    if (!file || !fileId) return;
    const line = Array.from(file.querySelectorAll<HTMLElement>('[data-line-id]')).find(element => element.getBoundingClientRect().bottom > top + 40);
    this.anchor = { fileId, lineId: line?.dataset['lineId'], offset: (line ?? file).getBoundingClientRect().top - top };
  }
  private restoreAnchor(): void {
    const anchor = this.anchor;
    const root = this.scroller()?.nativeElement;
    if (!root || !anchor) return;
    const file = this.fileElements().find(reference => reference.nativeElement.dataset['fileId'] === anchor.fileId)?.nativeElement;
    if (!file) return;
    const line = anchor.lineId ? Array.from(file.querySelectorAll<HTMLElement>('[data-line-id]')).find(element => element.dataset['lineId'] === anchor.lineId) : undefined;
    if (anchor.lineId && !line) return;
    const element = line ?? file;
    root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
  }
  protected scrolled(): void {
    if (this.scrollFrame !== undefined) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = undefined;
      const root = this.scroller()?.nativeElement;
      if (!root) return;
      const top = root.getBoundingClientRect().top;
      const element = this.fileElements().find(reference => reference.nativeElement.getBoundingClientRect().bottom > top + 40)?.nativeElement;
      const id = element?.dataset['fileId'];
      if (id && id !== this.current()?.id) { this.localSelected.set(id); this.fileSelected.emit(id); }
      this.captureAnchor();
    });
  }
  private nextChange(backwards: boolean): void {
    const root = this.scroller()?.nativeElement;
    if (!root) return;
    const top = root.getBoundingClientRect().top + 40;
    const lines = Array.from(root.querySelectorAll<HTMLElement>('[data-kind="add"], [data-kind="del"]'));
    const line = backwards ? lines.reverse().find(element => element.getBoundingClientRect().top < top - 2) : lines.find(element => element.getBoundingClientRect().top > top + 2);
    if (line) this.align(line, 40);
  }
  protected keydown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); this.step(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key.toLowerCase() === 'v' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const file = this.current();
      if (file) { event.preventDefault(); this.viewFile({ fileId: file.id, rev: file.rev, viewed: !(file.viewed && !file.changedSinceViewed) }); }
    }
    if (event.key === 'Escape') { event.preventDefault(); if (this.listOpen()) this.listOpen.set(false); else this.exitRequested.emit(); }
    if (event.key === 'F7') { event.preventDefault(); this.nextChange(event.shiftKey); }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); this.wideChange.emit(!this.wide()); }
  }

  private requestVisible(file: ChangeFile, mode = this.mode(), reason: 'visible' | 'selected' = 'visible'): void {
    if (file.binary || file.status === 'D' || (file.viewed && !file.changedSinceViewed) || file.add + file.del > this.largeAt()) return;
    const content = this.contentMap().get(file.id);
    if (content && content.mode === mode && content.rev === file.rev) return;
    const key = JSON.stringify([file.rev, mode]);
    if (this.requested.get(file.id) === key) return;
    this.requested.set(file.id, key);
    this.fileRequested.emit({ fileId: file.id, rev: file.rev, mode, reason });
  }
}
