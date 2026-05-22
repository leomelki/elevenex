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
  lucideFileText,
  lucideMessageSquarePlus,
  lucidePanelRightClose,
  lucidePencil,
  lucideSearch,
  lucideSend,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { MarkdownPipe } from '../session/claude-workspace/pipes/markdown.pipe';
import {
  formatPlanFeedbackMessage,
  formatPlanRejectionMessage,
  planDraftStorageKey,
} from './plan-feedback';
import {
  PlanAnnotatorComment,
  PlanFeedbackPayload,
  PlanReviewRequest,
} from './plan-review.model';

interface PlanHeading {
  id: string;
  level: number;
  text: string;
}

type DraftScope = 'selection' | 'document';

@Component({
  selector: 'app-plan-annotator-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronRight,
      lucideFileText,
      lucideMessageSquarePlus,
      lucidePanelRightClose,
      lucidePencil,
      lucideSearch,
      lucideSend,
      lucideTrash2,
      lucideX,
    }),
  ],
  template: `
    @if (review(); as activeReview) {
      <section class="pa-panel" aria-label="Plan annotator">
        <header class="pa-topbar">
          <div class="pa-title">
            <span class="pa-icon" aria-hidden="true">
              <ng-icon name="lucideFileText" size="16" />
            </span>
            <div class="pa-title__copy">
              <span class="pa-eyebrow">{{ providerLabel() }} plan review</span>
              <h2>Review plan</h2>
            </div>
          </div>

          <div class="pa-actions">
            <button type="button" class="pa-btn pa-btn--ghost" (click)="startDocumentComment()" [disabled]="readonly()">
              <ng-icon name="lucideMessageSquarePlus" size="14" />
              Document comment
            </button>
            <button type="button" class="pa-icon-btn" title="Close review" aria-label="Close review" (click)="close.emit(activeReview)">
              <ng-icon name="lucidePanelRightClose" size="15" />
            </button>
          </div>
        </header>

        <div class="pa-meta">
          <span>{{ activeReview.source === 'exit-plan-permission' ? 'Approval request' : 'Transcript plan' }}</span>
          @if (activeReview.planFilePath) {
            <code [title]="activeReview.planFilePath">{{ activeReview.planFilePath }}</code>
          }
          @if (comments().length) {
            <span>{{ comments().length }} pending comment{{ comments().length === 1 ? '' : 's' }}</span>
          }
        </div>

        <div class="pa-layout">
          <aside class="pa-outline" aria-label="Plan outline">
            <label class="pa-search">
              <ng-icon name="lucideSearch" size="13" aria-hidden="true" />
              <input
                type="search"
                placeholder="Search plan"
                [ngModel]="query()"
                (ngModelChange)="query.set($event)"
              />
            </label>

            <div class="pa-progress" aria-hidden="true">
              <span [style.width.%]="readingProgress()"></span>
            </div>

            @if (headings().length) {
              <nav class="pa-outline__list">
                @for (heading of headings(); track heading.id) {
                  <button
                    type="button"
                    class="pa-outline__item"
                    [style.paddingLeft.rem]="0.55 + (heading.level - 1) * 0.55"
                    (click)="scrollToText(heading.text)"
                  >
                    {{ heading.text }}
                  </button>
                }
              </nav>
            } @else {
              <p class="pa-empty">No headings found.</p>
            }
          </aside>

          <main #scrollRoot class="pa-reader" (scroll)="onReaderScroll()">
            @if (activeReview.before) {
              <section class="pa-preface cw-md" [innerHTML]="activeReview.before | cwMarkdown"></section>
            }

            <article
              #planDocument
              class="pa-doc cw-md"
              [class.pa-doc--selection]="selectedQuote()"
              (mouseup)="captureSelection()"
              (keyup)="captureSelection()"
              [innerHTML]="activeReview.planMarkdown | cwMarkdown"
            ></article>

            @if (activeReview.after) {
              <section class="pa-preface cw-md" [innerHTML]="activeReview.after | cwMarkdown"></section>
            }
          </main>

          <aside class="pa-comments" aria-label="Pending comments">
            <div class="pa-comments__head">
              <div>
                <span class="pa-eyebrow">Feedback</span>
                <h3>Pending comments</h3>
              </div>
              @if (comments().length) {
                <button type="button" class="pa-link-btn" (click)="clearComments()" [disabled]="readonly()">Clear all</button>
              }
            </div>

            @if (draftOpen()) {
              <form class="pa-draft" (submit)="$event.preventDefault(); saveDraft()">
                <label for="pa-draft-note">{{ draftScope() === 'document' ? 'Document comment' : 'Comment on selection' }}</label>
                @if (draftScope() === 'selection') {
                  <blockquote>{{ draftQuote() }}</blockquote>
                }
                <textarea
                  id="pa-draft-note"
                  rows="4"
                  placeholder="What should change?"
                  [ngModel]="draftNote()"
                  (ngModelChange)="draftNote.set($event)"
                ></textarea>
                <div class="pa-draft__actions">
                  <button type="button" class="pa-btn pa-btn--ghost" (click)="cancelDraft()">Cancel</button>
                  <button type="submit" class="pa-btn pa-btn--primary" [disabled]="!draftNote().trim()">Save</button>
                </div>
              </form>
            } @else if (selectedQuote() && !readonly()) {
              <button type="button" class="pa-selection" (click)="startSelectionComment()">
                <ng-icon name="lucideMessageSquarePlus" size="14" />
                Comment on selection
              </button>
            }

            @if (comments().length) {
              <div class="pa-comment-list">
                @for (comment of comments(); track comment.id; let index = $index) {
                  <article class="pa-comment" [class.pa-comment--active]="activeCommentId() === comment.id">
                    <button type="button" class="pa-comment__jump" (click)="jumpToComment(comment)">
                      <ng-icon name="lucideChevronRight" size="13" />
                      Comment {{ index + 1 }}
                    </button>
                    @if (comment.scope === 'selection') {
                      <blockquote>{{ comment.quote }}</blockquote>
                    } @else {
                      <span class="pa-comment__scope">Document-wide</span>
                    }
                    @if (editingCommentId() === comment.id) {
                      <textarea
                        rows="3"
                        [ngModel]="editingNote()"
                        (ngModelChange)="editingNote.set($event)"
                      ></textarea>
                      <div class="pa-comment__actions">
                        <button type="button" class="pa-icon-btn" title="Cancel edit" (click)="cancelEditComment()">
                          <ng-icon name="lucideX" size="13" />
                        </button>
                        <button
                          type="button"
                          class="pa-icon-btn pa-icon-btn--primary"
                          title="Save edit"
                          [disabled]="!editingNote().trim()"
                          (click)="saveEditComment(comment.id)"
                        >
                          <ng-icon name="lucideCheck" size="13" />
                        </button>
                      </div>
                    } @else {
                      <p>{{ comment.note }}</p>
                      <div class="pa-comment__actions">
                        <button type="button" class="pa-icon-btn" title="Edit comment" [disabled]="readonly()" (click)="editComment(comment)">
                          <ng-icon name="lucidePencil" size="13" />
                        </button>
                        <button type="button" class="pa-icon-btn" title="Delete comment" [disabled]="readonly()" (click)="removeComment(comment.id)">
                          <ng-icon name="lucideTrash2" size="13" />
                        </button>
                      </div>
                    }
                  </article>
                }
              </div>
            } @else if (!draftOpen()) {
              <p class="pa-empty">Select text in the plan or add a document comment.</p>
            }

            <footer class="pa-submit">
              <button type="button" class="pa-btn pa-btn--ghost" [disabled]="readonly()" (click)="rejectReview(activeReview)">
                <ng-icon name="lucideX" size="14" />
                Reject
              </button>
              <button type="button" class="pa-btn pa-btn--secondary" [disabled]="readonly() || !comments().length" (click)="sendReviewFeedback(activeReview)">
                <ng-icon name="lucideSend" size="14" />
                Send feedback
              </button>
              <button type="button" class="pa-btn pa-btn--primary" [disabled]="readonly()" (click)="approveReview(activeReview)">
                <ng-icon name="lucideCheck" size="14" />
                Approve
              </button>
            </footer>
          </aside>
        </div>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }

      .pa-panel {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--background);
        color: var(--foreground);
        border-left: 1px solid var(--border);
      }

      .pa-topbar,
      .pa-meta,
      .pa-submit {
        flex-shrink: 0;
      }

      .pa-topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.8rem 0.9rem;
        border-bottom: 1px solid var(--border);
        background: color-mix(in oklab, var(--card) 92%, var(--background));
      }

      .pa-title,
      .pa-actions,
      .pa-draft__actions,
      .pa-comment__actions,
      .pa-submit {
        display: flex;
        align-items: center;
      }

      .pa-title {
        gap: 0.65rem;
        min-width: 0;
      }

      .pa-icon {
        display: inline-flex;
        width: 2rem;
        height: 2rem;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--primary) 8%, var(--card));
        color: var(--primary);
        flex-shrink: 0;
      }

      .pa-title__copy {
        min-width: 0;
      }

      .pa-eyebrow {
        display: block;
        font-size: 0.66rem;
        line-height: 1.2;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }

      h2,
      h3 {
        margin: 0;
        line-height: 1.25;
        color: var(--foreground);
      }

      h2 {
        font-size: 0.98rem;
      }

      h3 {
        font-size: 0.86rem;
      }

      .pa-actions {
        gap: 0.45rem;
      }

      .pa-meta {
        display: flex;
        min-height: 2rem;
        align-items: center;
        gap: 0.6rem;
        padding: 0.35rem 0.9rem;
        border-bottom: 1px solid var(--border);
        color: var(--muted-foreground);
        font-size: 0.74rem;
        overflow: hidden;
      }

      .pa-meta code {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--foreground);
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        border-radius: 0.3rem;
        padding: 0.08rem 0.35rem;
      }

      .pa-layout {
        display: grid;
        grid-template-columns: minmax(11rem, 13rem) minmax(0, 1fr) minmax(17rem, 20rem);
        min-height: 0;
        flex: 1;
      }

      .pa-outline,
      .pa-comments {
        min-height: 0;
        overflow: auto;
        background: color-mix(in oklab, var(--card) 88%, var(--background));
      }

      .pa-outline {
        border-right: 1px solid var(--border);
        padding: 0.75rem;
      }

      .pa-search {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-height: 2rem;
        border: 1px solid var(--input);
        border-radius: 0.45rem;
        background: var(--background);
        color: var(--muted-foreground);
        padding: 0 0.55rem;
      }

      .pa-search input {
        min-width: 0;
        flex: 1;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--foreground);
        font: inherit;
        font-size: 0.78rem;
      }

      .pa-progress {
        height: 0.25rem;
        margin: 0.7rem 0;
        overflow: hidden;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
      }

      .pa-progress span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--primary);
      }

      .pa-outline__list,
      .pa-comment-list {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }

      .pa-outline__item {
        width: 100%;
        min-height: 1.85rem;
        border: 0;
        border-radius: 0.4rem;
        background: transparent;
        color: var(--muted-foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.76rem;
        line-height: 1.35;
        text-align: left;
      }

      .pa-outline__item:hover,
      .pa-outline__item:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 8%, transparent);
        color: var(--foreground);
      }

      .pa-reader {
        min-width: 0;
        min-height: 0;
        overflow: auto;
        padding: 1rem clamp(1rem, 3vw, 2.5rem);
        background: var(--background);
      }

      .pa-doc,
      .pa-preface {
        max-width: 58rem;
        margin: 0 auto;
      }

      .pa-preface {
        margin-bottom: 1rem;
        padding: 0.8rem 1rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--muted) 36%, transparent);
      }

      .pa-doc {
        padding: 0.25rem 0 3rem;
        user-select: text;
      }

      .cw-md {
        font-size: 0.9rem;
        line-height: 1.72;
      }
      .cw-md :first-child {
        margin-top: 0;
      }
      .cw-md :last-child {
        margin-bottom: 0;
      }
      .cw-md p {
        margin: 0.65rem 0;
      }
      .cw-md ul,
      .cw-md ol {
        margin: 0.65rem 0;
        padding-left: 1.35rem;
      }
      .cw-md li {
        margin: 0.18rem 0;
      }
      .cw-md h1,
      .cw-md h2,
      .cw-md h3,
      .cw-md h4 {
        margin: 1.25rem 0 0.45rem;
        color: var(--foreground);
        font-weight: 700;
        line-height: 1.25;
      }
      .cw-md h1 {
        font-size: 1.55rem;
      }
      .cw-md h2 {
        font-size: 1.24rem;
        padding-bottom: 0.25rem;
        border-bottom: 1px solid var(--border);
      }
      .cw-md h3 {
        font-size: 1.05rem;
      }
      .cw-md h4 {
        font-size: 0.95rem;
      }
      .cw-md code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.86em;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        padding: 0.08rem 0.32rem;
        border-radius: 0.25rem;
      }
      .cw-md pre {
        margin: 0.75rem 0;
        padding: 0.8rem 0.9rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        overflow: auto;
        font-size: 0.82rem;
        line-height: 1.6;
      }
      .cw-md pre code {
        background: transparent;
        padding: 0;
        font-size: inherit;
      }
      .cw-md blockquote {
        margin: 0.75rem 0;
        padding: 0.2rem 0.8rem;
        border-left: 3px solid var(--border);
        color: var(--muted-foreground);
      }
      .cw-md table {
        width: 100%;
        border-collapse: collapse;
        margin: 0.75rem 0;
        font-size: 0.84rem;
      }
      .cw-md th,
      .cw-md td {
        border: 1px solid var(--border);
        padding: 0.35rem 0.55rem;
        text-align: left;
      }

      .pa-doc--selection {
        outline: 2px solid color-mix(in oklab, var(--primary) 36%, transparent);
        outline-offset: 0.45rem;
        border-radius: 0.35rem;
      }

      .pa-comments {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        border-left: 1px solid var(--border);
        padding: 0.8rem;
      }

      .pa-comments__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 0.6rem;
      }

      .pa-empty {
        margin: 0;
        padding: 0.7rem;
        border: 1px dashed var(--border);
        border-radius: 0.5rem;
        color: var(--muted-foreground);
        font-size: 0.78rem;
        line-height: 1.45;
      }

      .pa-draft,
      .pa-comment {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        border: 1px solid var(--border);
        border-radius: 0.55rem;
        background: var(--card);
        padding: 0.7rem;
      }

      .pa-draft label {
        font-size: 0.76rem;
        font-weight: 700;
      }

      blockquote {
        margin: 0;
        padding: 0.45rem 0.55rem;
        border-left: 3px solid color-mix(in oklab, var(--primary) 55%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--background));
        color: var(--foreground);
        font-size: 0.75rem;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }

      textarea {
        width: 100%;
        resize: vertical;
        border: 1px solid var(--input);
        border-radius: 0.45rem;
        background: var(--background);
        color: var(--foreground);
        padding: 0.55rem 0.65rem;
        font: inherit;
        font-size: 0.8rem;
        line-height: 1.45;
      }

      textarea:focus {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 66%, var(--input));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 18%, transparent);
      }

      .pa-selection {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        min-height: 2.25rem;
        border: 1px dashed color-mix(in oklab, var(--primary) 45%, var(--border));
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--primary) 7%, transparent);
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        font-weight: 700;
      }

      .pa-comment--active {
        border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 12%, transparent);
      }

      .pa-comment__jump {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        align-self: flex-start;
        border: 0;
        background: transparent;
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 700;
        padding: 0;
      }

      .pa-comment__scope {
        align-self: flex-start;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--muted-foreground);
        font-size: 0.68rem;
        font-weight: 700;
        padding: 0.12rem 0.45rem;
      }

      .pa-comment p {
        margin: 0;
        color: var(--foreground);
        font-size: 0.8rem;
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .pa-comment__actions,
      .pa-draft__actions {
        justify-content: flex-end;
        gap: 0.4rem;
      }

      .pa-submit {
        gap: 0.45rem;
        margin-top: auto;
        padding-top: 0.2rem;
      }

      .pa-btn,
      .pa-icon-btn,
      .pa-link-btn {
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          color 140ms ease,
          opacity 140ms ease;
      }

      .pa-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        min-height: 2rem;
        padding: 0 0.7rem;
        border-radius: 0.45rem;
        font-size: 0.78rem;
        font-weight: 700;
        white-space: nowrap;
      }

      .pa-btn--primary,
      .pa-icon-btn--primary {
        border-color: var(--primary);
        background: var(--primary);
        color: var(--primary-foreground);
      }

      .pa-btn--secondary {
        border-color: color-mix(in oklab, var(--primary) 42%, var(--border));
        background: color-mix(in oklab, var(--primary) 8%, var(--background));
        color: var(--foreground);
      }

      .pa-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.85rem;
        height: 1.85rem;
        border-radius: 0.45rem;
        padding: 0;
      }

      .pa-link-btn {
        border: 0;
        background: transparent;
        color: var(--muted-foreground);
        padding: 0;
        font-size: 0.72rem;
        font-weight: 700;
      }

      .pa-btn:hover:not(:disabled),
      .pa-icon-btn:hover:not(:disabled),
      .pa-link-btn:hover:not(:disabled),
      .pa-btn:focus-visible,
      .pa-icon-btn:focus-visible,
      .pa-link-btn:focus-visible {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 42%, var(--border));
        background: color-mix(in oklab, var(--primary) 8%, var(--background));
      }

      .pa-btn--primary:hover:not(:disabled),
      .pa-icon-btn--primary:hover:not(:disabled),
      .pa-btn--primary:focus-visible,
      .pa-icon-btn--primary:focus-visible {
        background: color-mix(in oklab, var(--primary) 88%, var(--foreground));
        color: var(--primary-foreground);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      @media (max-width: 1100px) {
        .pa-layout {
          grid-template-columns: minmax(0, 1fr) minmax(16rem, 19rem);
        }

        .pa-outline {
          display: none;
        }
      }

      @media (max-width: 760px) {
        .pa-topbar,
        .pa-actions,
        .pa-submit {
          align-items: stretch;
          flex-direction: column;
        }

        .pa-layout {
          grid-template-columns: 1fr;
          overflow: auto;
        }

        .pa-reader {
          min-height: 55vh;
        }

        .pa-comments {
          border-left: 0;
          border-top: 1px solid var(--border);
          overflow: visible;
        }
      }
    `,
  ],
})
export class PlanAnnotatorPanelComponent {
  readonly review = input<PlanReviewRequest | null>(null);

  readonly close = output<PlanReviewRequest>();
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
  readonly providerLabel = computed(() => (this.review()?.provider === 'codex' ? 'Codex' : 'Claude Code'));
  readonly headings = computed(() => extractHeadings(this.review()?.planMarkdown ?? ''));

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
    this.draftScope.set('selection');
    this.draftQuote.set(quote);
    this.draftContext.set(this.selectedContext() || quote);
    this.draftNote.set('');
    this.draftOpen.set(true);
  }

  startDocumentComment(): void {
    if (this.readonly()) return;
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
      comments.map((comment) => comment.id === id ? { ...comment, note, updatedAt: now } : comment),
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
    this.readingProgress.set(max <= 0 ? 0 : Math.min(100, Math.max(0, (root.scrollTop / max) * 100)));
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
    typeof record['id'] === 'string'
    && (record['scope'] === 'selection' || record['scope'] === 'document')
    && typeof record['note'] === 'string'
    && typeof record['createdAt'] === 'string'
    && typeof record['updatedAt'] === 'string'
  );
}

function extractHeadings(markdown: string): PlanHeading[] {
  const seen = new Map<string, number>();
  return markdown
    .split('\n')
    .map((line) => /^(#{1,4})\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => {
      const text = match[2].replace(/[#*_`[\]]/g, '').trim();
      const base = slug(text) || 'section';
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return {
        id: count ? `${base}-${count + 1}` : base,
        level: match[1].length,
        text,
      };
    });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
