import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent, IconButtonComponent, SkeletonComponent } from '../ui';
import { ChangeFile, DiffComment, DiffContextRequest, DiffFileContent, DiffFileRequest, DiffHunk, DiffLine, ReviewMode, CHANGE_STATUS_LABEL, fileName, folderName } from './view.models';

interface LineDraft { readonly identity: string; readonly line: DiffLine }
interface LineNote { readonly identity: string; readonly lineId: string; readonly text: string }

@Component({
  selector: 'ex-diff-file',
  imports: [ButtonComponent, FoldComponent, IconComponent, IconButtonComponent, SkeletonComponent],
  templateUrl: './diff-file.component.html',
  styleUrl: './diff-file.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffFileComponent {
  readonly file = input.required<ChangeFile>();
  readonly content = input<DiffFileContent>();
  readonly mode = input<ReviewMode>('changes');
  readonly wrap = input(true);
  readonly wide = input(false);
  readonly commentsEnabled = input(true);
  readonly largeAt = input(400);
  readonly viewedChange = output<{ fileId: string; rev?: string | number; viewed: boolean }>();
  readonly fileRequested = output<DiffFileRequest>();
  readonly contextRequested = output<DiffContextRequest>();
  readonly commented = output<DiffComment>();
  readonly openRequested = output<string>();
  protected readonly names = fileName;
  protected readonly folders = folderName;
  protected readonly statusLabels = CHANGE_STATUS_LABEL;
  private readonly collapsedIdentity = signal<string | null>(null);
  private readonly expandedIdentity = signal<string | null>(null);
  private readonly allowedIdentity = signal<string | null>(null);
  private readonly pageSelection = signal({ identity: '', index: 0 });
  protected readonly draft = signal<LineDraft | null>(null);
  protected readonly draftText = signal('');
  protected readonly notes = signal<readonly LineNote[]>([]);
  protected readonly identity = computed(() => JSON.stringify([this.file().id, this.file().rev, this.mode()]));
  protected readonly viewed = computed(() => !!this.file().viewed && !this.file().changedSinceViewed);
  protected readonly open = computed(() => this.collapsedIdentity() !== this.identity() && (!this.viewed() || this.expandedIdentity() === this.identity()));
  protected readonly allowed = computed(() => (this.file().status !== 'D' && this.file().add + this.file().del <= this.largeAt()) || this.allowedIdentity() === this.identity());
  protected readonly currentContent = computed(() => {
    const content = this.content();
    return content && content.fileId === this.file().id && content.rev === this.file().rev && content.mode === this.mode() ? content : undefined;
  });
  protected readonly totalLines = computed(() => this.currentContent()?.hunks?.reduce((sum, hunk) => sum + hunk.lines.length, 0) ?? 0);
  protected readonly linePages = computed(() => Math.max(1, Math.ceil(this.totalLines() / 400)));
  protected readonly page = computed(() => this.pageSelection().identity === this.identity() ? Math.min(this.pageSelection().index, this.linePages() - 1) : 0);
  protected readonly hunks = computed<readonly DiffHunk[]>(() => {
    let skipped = 0;
    const start = Math.min(this.page(), this.linePages() - 1) * 400;
    const end = start + 400;
    return (this.currentContent()?.hunks ?? []).flatMap(hunk => {
      const from = Math.max(0, start - skipped);
      const until = Math.min(hunk.lines.length, end - skipped);
      skipped += hunk.lines.length;
      return until > from ? [{ ...hunk, lines: hunk.lines.slice(from, until) }] : [];
    });
  });
  protected readonly lineNumberWidth = computed(() => {
    let largest = 0;
    for (const hunk of this.hunks()) for (const line of hunk.lines) largest = Math.max(largest, line.oldNumber ?? 0, line.newNumber ?? 0);
    return `calc(${String(largest).length}ch + var(--space-2))`;
  });
  protected readonly currentDraft = computed(() => this.draft()?.identity === this.identity() ? this.draft() : null);
  protected readonly currentNotes = computed(() => this.notes().filter(note => note.identity === this.identity()));
  protected readonly skeletonRows = computed(() => Math.max(3, Math.min(12, this.file().add + this.file().del)));
  private readonly commentInput = viewChild<ElementRef<HTMLTextAreaElement>>('commentText');
  private focusedComment?: HTMLTextAreaElement;
  private returnFocus?: HTMLElement;

  constructor() {
    afterRenderEffect(() => {
      const input = this.commentInput()?.nativeElement;
      if (input && input !== this.focusedComment) {
        if (document.activeElement instanceof HTMLElement) this.returnFocus = document.activeElement;
        input.focus({ preventScroll: true });
      } else if (!input && this.focusedComment && this.returnFocus?.isConnected) {
        this.returnFocus.focus({ preventScroll: true });
        this.returnFocus = undefined;
      }
      this.focusedComment = input;
    });
  }

  protected stepLines(direction: 1 | -1): void {
    this.pageSelection.set({ identity: this.identity(), index: Math.max(0, Math.min(this.linePages() - 1, this.page() + direction)) });
  }

  protected toggle(): void {
    if (this.open()) this.collapsedIdentity.set(this.identity());
    else {
      this.collapsedIdentity.set(null);
      this.expandedIdentity.set(this.identity());
      if (!this.currentContent() && this.allowed()) this.request('selected');
    }
  }
  protected markViewed(): void {
    this.viewedChange.emit({ fileId: this.file().id, rev: this.file().rev, viewed: !this.viewed() });
  }
  protected request(reason: DiffFileRequest['reason']): void {
    if (reason === 'large' || reason === 'deleted') this.allowedIdentity.set(this.identity());
    this.fileRequested.emit({ fileId: this.file().id, rev: this.file().rev, mode: this.mode(), reason });
  }
  protected context(hunkId: string, direction: 'before' | 'after', remaining: number): void {
    this.contextRequested.emit({ fileId: this.file().id, rev: this.file().rev, mode: this.mode(), hunkId, direction, count: Math.min(20, remaining) });
  }
  protected startComment(line: DiffLine): void {
    this.draft.set({ identity: this.identity(), line });
    this.draftText.set('');
  }
  protected sendComment(): void {
    const draft = this.currentDraft();
    const text = this.draftText().trim();
    if (!draft || !text) return;
    const side = draft.line.kind === 'del' ? 'old' : 'new';
    const line = side === 'old' ? draft.line.oldNumber : draft.line.newNumber;
    if (line === undefined) return;
    this.commented.emit({ fileId: this.file().id, path: this.file().path, rev: this.file().rev, line, side, text });
    this.notes.update(notes => [...notes.slice(-99), { identity: this.identity(), lineId: draft.line.id, text }]);
    this.draft.set(null);
  }
  protected commentKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.sendComment(); }
    if (event.key === 'Escape') { event.stopPropagation(); this.draft.set(null); }
  }
}
