import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronRight,
  lucideMessageSquarePlus,
  lucidePanelRightClose,
  lucidePencil,
  lucideSearch,
  lucideSend,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { MarkdownPipe } from '../session/claude-workspace/pipes/markdown.pipe';
import {
  formatPlanFeedbackMessage,
  formatPlanRejectionMessage,
  planDraftStorageKey,
} from './plan-feedback';
import { PlanMarkdownBlocksComponent } from './plan-markdown-blocks.component';
import { PlanAnnotatorComment, PlanFeedbackPayload, PlanReviewRequest } from './plan-review.model';
import { PlanChatPanelComponent } from './plan-chat-panel.component';
import { PlanReviewRailMode } from './plan-annotator-state.service';

type DraftScope = 'selection' | 'document';

@Component({
  selector: 'app-plan-annotator-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MarkdownPipe,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    PlanMarkdownBlocksComponent,
    PlanChatPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronRight,
      lucideMessageSquarePlus,
      lucidePanelRightClose,
      lucidePencil,
      lucideSearch,
      lucideSend,
      lucideTrash2,
      lucideX,
    }),
  ],
  templateUrl: './plan-annotator-panel.component.html',
  styleUrls: ['./plan-annotator-panel.component.scss'],
})
export class PlanAnnotatorPanelComponent {
  readonly review = input<PlanReviewRequest | null>(null);
  readonly railMode = input<PlanReviewRailMode>('comments');

  readonly close = output<PlanReviewRequest>();
  readonly railModeChange = output<PlanReviewRailMode>();
  readonly approve = output<PlanReviewRequest>();
  readonly reject = output<PlanFeedbackPayload>();
  readonly sendFeedback = output<PlanFeedbackPayload>();

  private readonly planDocument = viewChild<ElementRef<HTMLElement>>('planDocument');
  private readonly scrollRoot = viewChild<ElementRef<HTMLElement>>('scrollRoot');

  readonly comments = signal<PlanAnnotatorComment[]>([]);
  readonly selectedQuote = signal('');
  readonly selectedContext = signal('');
  readonly draftOpen = signal(false);
  readonly draftScope = signal<DraftScope>('selection');
  readonly draftQuote = signal('');
  readonly draftContext = signal('');
  readonly draftNote = signal('');
  readonly query = signal('');
  readonly readingProgress = signal(0);
  readonly activeCommentId = signal<string | null>(null);
  readonly editingCommentId = signal<string | null>(null);
  readonly editingNote = signal('');

  readonly readonly = computed(() => this.review()?.readonly === true);
  readonly providerLabel = computed(() =>
    this.review()?.provider === 'codex' ? 'Codex' : 'Claude Code',
  );
  readonly activeRailMode = computed<PlanReviewRailMode>(() => {
    const review = this.review();
    const mode = this.railMode();
    return mode === 'ask' && review && this.canAskPlan(review) ? 'ask' : 'comments';
  });

  private loadedStorageKey = '';

  constructor() {
    effect(() => {
      const review = this.review();
      if (!review) return;
      const key = planDraftStorageKey(review);
      if (key === this.loadedStorageKey) return;
      this.loadedStorageKey = key;
      this.comments.set(loadComments(key));
      this.cancelDraft();
      this.query.set('');
      this.readingProgress.set(0);
    });

    effect(() => {
      const review = this.review();
      if (!review) return;
      const key = planDraftStorageKey(review);
      const comments = this.comments();
      try {
        if (comments.length) {
          localStorage.setItem(key, JSON.stringify(comments));
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        // Ignore storage errors; comments still work for the current render.
      }
    });
  }

  captureSelection(): void {
    if (this.readonly()) return;
    const root = this.planDocument()?.nativeElement;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) {
      this.selectedQuote.set('');
      this.selectedContext.set('');
      return;
    }
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) {
      this.selectedQuote.set('');
      this.selectedContext.set('');
      return;
    }

    const quote = compactWhitespace(selection.toString()).slice(0, 900);
    this.selectedQuote.set(quote);
    this.selectedContext.set(buildContext(this.review()?.planMarkdown ?? '', quote));
  }

  startSelectionComment(): void {
    const quote = this.selectedQuote().trim();
    if (!quote) return;
    this.selectRailMode('comments');
    this.draftScope.set('selection');
    this.draftQuote.set(quote);
    this.draftContext.set(this.selectedContext() || quote);
    this.draftNote.set('');
    this.draftOpen.set(true);
  }

  startDocumentComment(): void {
    if (this.readonly()) return;
    this.selectRailMode('comments');
    this.draftScope.set('document');
    this.draftQuote.set('');
    this.draftContext.set('');
    this.draftNote.set('');
    this.draftOpen.set(true);
  }

  cancelDraft(): void {
    this.draftOpen.set(false);
    this.draftQuote.set('');
    this.draftContext.set('');
    this.draftNote.set('');
  }

  saveDraft(): void {
    const note = this.draftNote().trim();
    if (!note) return;
    const now = new Date().toISOString();
    this.comments.update((comments) => [
      ...comments,
      {
        id: `comment-${Date.now()}-${comments.length}`,
        scope: this.draftScope(),
        quote: this.draftQuote().trim(),
        context: this.draftContext().trim(),
        note,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    this.cancelDraft();
    window.getSelection()?.removeAllRanges();
    this.selectedQuote.set('');
    this.selectedContext.set('');
  }

  editComment(comment: PlanAnnotatorComment): void {
    this.editingCommentId.set(comment.id);
    this.editingNote.set(comment.note);
  }

  cancelEditComment(): void {
    this.editingCommentId.set(null);
    this.editingNote.set('');
  }

  saveEditComment(id: string): void {
    const note = this.editingNote().trim();
    if (!note) return;
    const now = new Date().toISOString();
    this.comments.update((comments) =>
      comments.map((comment) =>
        comment.id === id ? { ...comment, note, updatedAt: now } : comment,
      ),
    );
    this.cancelEditComment();
  }

  removeComment(id: string): void {
    this.comments.update((comments) => comments.filter((comment) => comment.id !== id));
  }

  clearComments(): void {
    this.comments.set([]);
  }

  jumpToComment(comment: PlanAnnotatorComment): void {
    this.activeCommentId.set(comment.id);
    if (comment.scope === 'selection') {
      this.scrollToText(comment.quote);
    } else {
      this.scrollRoot()?.nativeElement.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  scrollToText(text: string): void {
    const root = this.planDocument()?.nativeElement;
    if (!root || !text.trim()) return;
    const target = findElementContainingText(root, text);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  onReaderScroll(): void {
    const root = this.scrollRoot()?.nativeElement;
    if (!root) return;
    const max = root.scrollHeight - root.clientHeight;
    this.readingProgress.set(
      max <= 0 ? 0 : Math.min(100, Math.max(0, (root.scrollTop / max) * 100)),
    );
  }

  sendReviewFeedback(review: PlanReviewRequest): void {
    const comments = this.comments();
    if (!comments.length) return;
    this.sendFeedback.emit({
      review,
      comments,
      message: formatPlanFeedbackMessage(comments),
    });
    this.comments.set([]);
  }

  rejectReview(review: PlanReviewRequest): void {
    const comments = this.comments();
    this.reject.emit({
      review,
      comments,
      message: formatPlanRejectionMessage(comments),
    });
    this.comments.set([]);
  }

  approveReview(review: PlanReviewRequest): void {
    this.comments.set([]);
    this.approve.emit(review);
  }

  canAskPlan(review: PlanReviewRequest): boolean {
    return Boolean(review.anchorMessageId && review.anchorMessageKind);
  }

  selectRailMode(mode: PlanReviewRailMode): void {
    this.railModeChange.emit(mode);
  }
}

function loadComments(key: string): PlanAnnotatorComment[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlanComment);
  } catch {
    return [];
  }
}

function isPlanComment(value: unknown): value is PlanAnnotatorComment {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    (record['scope'] === 'selection' || record['scope'] === 'document') &&
    typeof record['note'] === 'string' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['updatedAt'] === 'string'
  );
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildContext(plan: string, quote: string): string {
  const normalizedPlan = compactWhitespace(plan);
  const normalizedQuote = compactWhitespace(quote);
  const index = normalizedPlan.toLowerCase().indexOf(normalizedQuote.toLowerCase());
  if (index === -1) return normalizedQuote;
  const start = Math.max(0, index - 160);
  const end = Math.min(normalizedPlan.length, index + normalizedQuote.length + 160);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalizedPlan.length ? '...' : '';
  return `${prefix}${normalizedPlan.slice(start, end)}${suffix}`;
}

function findElementContainingText(root: HTMLElement, text: string): HTMLElement | null {
  const needle = compactWhitespace(text).slice(0, 160).toLowerCase();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const content = compactWhitespace(node.textContent ?? '').toLowerCase();
    if (content.includes(needle) || needle.includes(content)) {
      return node.parentElement;
    }
    node = walker.nextNode();
  }
  return null;
}
