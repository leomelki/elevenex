import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideMessageSquarePlus,
  lucideSend,
  lucideTrash2,
} from '@ng-icons/lucide';
import { MarkdownPipe } from '../pipes/markdown.pipe';
import { extractProposedPlan } from '../util/proposed-plan';

interface PlanComment {
  id: string;
  quote: string;
  context: string;
  note: string;
}

@Component({
  selector: 'cw-codex-plan-review',
  standalone: true,
  imports: [CommonModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideMessageSquarePlus,
      lucideSend,
      lucideTrash2,
    }),
  ],
  template: `
    <section class="cw-plan" aria-label="Proposed plan review">
      <header class="cw-plan__header">
        <div class="cw-plan__title-block">
          <div class="cw-plan__eyebrow">Plan review</div>
          <h3 class="cw-plan__title">Proposed plan</h3>
        </div>
        <div class="cw-plan__actions">
          <button
            type="button"
            class="cw-plan__btn cw-plan__btn--ghost"
            [disabled]="disabled() || !canAddComment()"
            title="Add comment for selected text"
            (click)="beginComment()"
          >
            <ng-icon name="lucideMessageSquarePlus" size="14" />
            Comment
          </button>
          <button
            type="button"
            class="cw-plan__btn cw-plan__btn--primary"
            [disabled]="disabled() || streaming()"
            title="Approve plan and ask Codex to implement it"
            (click)="approve.emit()"
          >
            <ng-icon name="lucideCheck" size="14" />
            Approve
          </button>
        </div>
      </header>

      @if (extraction()?.before) {
        <div class="cw-plan__preface cw-md" [innerHTML]="extraction()!.before | cwMarkdown"></div>
      }

      <div class="cw-plan__body">
        <article
          #planBody
          class="cw-plan__document cw-md"
          [class.cw-plan__document--selecting]="selectedQuote()"
          (mouseup)="captureSelection()"
          (keyup)="captureSelection()"
          [innerHTML]="planText() | cwMarkdown"
        ></article>

        <aside class="cw-plan__comments" aria-label="Plan comments">
          @if (draftQuote()) {
            <form class="cw-plan__draft" (submit)="$event.preventDefault(); saveDraftComment()">
              <label class="cw-plan__label" for="cw-plan-comment">Comment on selection</label>
              <blockquote class="cw-plan__quote">{{ draftQuote() }}</blockquote>
              <textarea
                id="cw-plan-comment"
                class="cw-plan__textarea"
                rows="4"
                placeholder="What should change?"
                [value]="draftNote()"
                (input)="draftNote.set($any($event.target).value)"
              ></textarea>
              <div class="cw-plan__draft-actions">
                <button type="button" class="cw-plan__btn cw-plan__btn--ghost" (click)="cancelDraftComment()">
                  Cancel
                </button>
                <button
                  type="submit"
                  class="cw-plan__btn cw-plan__btn--primary"
                  [disabled]="!draftNote().trim()"
                >
                  Save
                </button>
              </div>
            </form>
          }

          @if (comments().length) {
            <div class="cw-plan__comment-list">
              @for (comment of comments(); track comment.id; let index = $index) {
                <article class="cw-plan__comment">
                  <div class="cw-plan__comment-head">
                    <span>Comment {{ index + 1 }}</span>
                    <button
                      type="button"
                      class="cw-plan__icon-btn"
                      title="Remove comment"
                      aria-label="Remove comment"
                      (click)="removeComment(comment.id)"
                    >
                      <ng-icon name="lucideTrash2" size="13" />
                    </button>
                  </div>
                  <blockquote class="cw-plan__quote">{{ comment.quote }}</blockquote>
                  <p class="cw-plan__note">{{ comment.note }}</p>
                </article>
              }
            </div>
          } @else if (!draftQuote()) {
            <p class="cw-plan__empty">Select plan text to attach feedback.</p>
          }

          <button
            type="button"
            class="cw-plan__send"
            [disabled]="disabled() || !comments().length"
            (click)="sendFeedback()"
          >
            <ng-icon name="lucideSend" size="14" />
            Send feedback
          </button>
        </aside>
      </div>

      @if (extraction()?.after) {
        <div class="cw-plan__preface cw-md" [innerHTML]="extraction()!.after | cwMarkdown"></div>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        width: min(100%, 62rem);
      }

      .cw-plan {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
        border: 1px solid color-mix(in oklab, var(--primary) 22%, var(--border));
        border-radius: 0.75rem;
        background: color-mix(in oklab, var(--card) 94%, var(--background));
        box-shadow: 0 18px 40px -32px color-mix(in oklab, var(--foreground) 48%, transparent);
        overflow: hidden;
      }

      .cw-plan__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.9rem 1rem;
        border-bottom: 1px solid var(--border);
        background: color-mix(in oklab, var(--primary) 5%, var(--card));
      }

      .cw-plan__title-block {
        min-width: 0;
      }

      .cw-plan__eyebrow {
        font-size: 0.68rem;
        line-height: 1.2;
        font-weight: 700;
        text-transform: uppercase;
        color: color-mix(in oklab, var(--primary) 76%, var(--muted-foreground));
      }

      .cw-plan__title {
        margin: 0.1rem 0 0;
        font-size: 0.98rem;
        line-height: 1.3;
        color: var(--foreground);
      }

      .cw-plan__actions,
      .cw-plan__draft-actions {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .cw-plan__btn,
      .cw-plan__send,
      .cw-plan__icon-btn {
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
        font: inherit;
        cursor: pointer;
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          color 140ms ease,
          opacity 140ms ease;
      }

      .cw-plan__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        min-height: 2rem;
        padding: 0 0.7rem;
        border-radius: 0.45rem;
        font-size: 0.78rem;
        font-weight: 650;
        white-space: nowrap;
      }

      .cw-plan__btn--primary,
      .cw-plan__send {
        border-color: var(--primary);
        background: var(--primary);
        color: var(--primary-foreground);
      }

      .cw-plan__btn--ghost:hover:not(:disabled),
      .cw-plan__icon-btn:hover,
      .cw-plan__btn--ghost:focus-visible,
      .cw-plan__icon-btn:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        border-color: color-mix(in oklab, var(--foreground) 16%, var(--border));
      }

      .cw-plan__btn--primary:hover:not(:disabled),
      .cw-plan__btn--primary:focus-visible,
      .cw-plan__send:hover:not(:disabled),
      .cw-plan__send:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 88%, var(--foreground));
      }

      .cw-plan__btn:disabled,
      .cw-plan__send:disabled {
        cursor: not-allowed;
        opacity: 0.52;
      }

      .cw-plan__preface {
        padding: 0 1rem;
      }

      .cw-plan__body {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(15rem, 18rem);
        gap: 0;
        min-height: 24rem;
      }

      .cw-plan__document {
        min-width: 0;
        padding: 0.2rem 1.15rem 1.15rem;
        user-select: text;
      }

      .cw-plan__document--selecting {
        outline: 2px solid color-mix(in oklab, var(--primary) 36%, transparent);
        outline-offset: -0.35rem;
      }

      .cw-plan__comments {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.85rem;
        border-left: 1px solid var(--border);
        background: color-mix(in oklab, var(--muted) 32%, var(--card));
      }

      .cw-plan__empty {
        margin: 0;
        padding: 0.7rem;
        border: 1px dashed var(--border);
        border-radius: 0.5rem;
        color: var(--muted-foreground);
        font-size: 0.78rem;
        line-height: 1.45;
      }

      .cw-plan__draft,
      .cw-plan__comment {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        border: 1px solid var(--border);
        border-radius: 0.55rem;
        background: var(--card);
        padding: 0.7rem;
      }

      .cw-plan__label,
      .cw-plan__comment-head {
        font-size: 0.72rem;
        line-height: 1.35;
        font-weight: 700;
        color: var(--foreground);
      }

      .cw-plan__comment-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }

      .cw-plan__quote {
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

      .cw-plan__textarea {
        width: 100%;
        min-height: 5rem;
        resize: vertical;
        border: 1px solid var(--input);
        border-radius: 0.5rem;
        background: var(--background);
        color: var(--foreground);
        padding: 0.55rem 0.65rem;
        font: inherit;
        font-size: 0.8rem;
        line-height: 1.45;
      }

      .cw-plan__textarea:focus {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 66%, var(--input));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 18%, transparent);
      }

      .cw-plan__comment-list {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        min-height: 0;
      }

      .cw-plan__icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.6rem;
        height: 1.6rem;
        border-radius: 999px;
        color: var(--muted-foreground);
      }

      .cw-plan__note {
        margin: 0;
        color: var(--foreground);
        font-size: 0.8rem;
        line-height: 1.5;
        white-space: pre-wrap;
      }

      .cw-plan__send {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        min-height: 2.25rem;
        margin-top: auto;
        border-radius: 0.5rem;
        font-size: 0.8rem;
        font-weight: 700;
      }

      @media (max-width: 760px) {
        .cw-plan__header {
          align-items: flex-start;
          flex-direction: column;
        }

        .cw-plan__actions {
          width: 100%;
          justify-content: flex-start;
        }

        .cw-plan__body {
          grid-template-columns: 1fr;
        }

        .cw-plan__comments {
          border-left: 0;
          border-top: 1px solid var(--border);
        }
      }
    `,
  ],
})
export class CodexPlanReviewComponent {
  readonly content = input.required<string>();
  readonly disabled = input(false);
  readonly streaming = input(false);
  readonly approve = output<void>();
  readonly feedback = output<string>();

  private readonly planBody = viewChild<ElementRef<HTMLElement>>('planBody');

  readonly comments = signal<PlanComment[]>([]);
  readonly selectedQuote = signal('');
  readonly draftQuote = signal('');
  readonly draftContext = signal('');
  readonly draftNote = signal('');

  readonly extraction = computed(() => extractProposedPlan(this.content()));
  readonly planText = computed(() => this.extraction()?.plan ?? this.content());
  readonly canAddComment = computed(() => !!this.selectedQuote().trim() && !this.draftQuote());

  captureSelection(): void {
    const root = this.planBody()?.nativeElement;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) {
      this.selectedQuote.set('');
      return;
    }
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) {
      this.selectedQuote.set('');
      return;
    }
    this.selectedQuote.set(compactWhitespace(selection.toString()).slice(0, 700));
  }

  beginComment(): void {
    const quote = this.selectedQuote().trim();
    if (!quote) return;
    this.draftQuote.set(quote);
    this.draftContext.set(buildContext(this.planText(), quote));
    this.draftNote.set('');
  }

  cancelDraftComment(): void {
    this.draftQuote.set('');
    this.draftContext.set('');
    this.draftNote.set('');
  }

  saveDraftComment(): void {
    const quote = this.draftQuote().trim();
    const note = this.draftNote().trim();
    if (!quote || !note) return;
    this.comments.update((comments) => [
      ...comments,
      {
        id: `comment-${Date.now()}-${comments.length}`,
        quote,
        context: this.draftContext().trim() || quote,
        note,
      },
    ]);
    this.cancelDraftComment();
    window.getSelection()?.removeAllRanges();
    this.selectedQuote.set('');
  }

  removeComment(id: string): void {
    this.comments.update((comments) => comments.filter((comment) => comment.id !== id));
  }

  sendFeedback(): void {
    const comments = this.comments();
    if (!comments.length) return;
    this.feedback.emit(formatFeedbackMessage(comments));
    this.comments.set([]);
    this.cancelDraftComment();
  }
}

function formatFeedbackMessage(comments: PlanComment[]): string {
  const sections = comments.map((comment, index) => {
    const lines = [
      `Feedback ${index + 1}:`,
      '',
      'Selected text:',
      quoteBlock(comment.quote),
      '',
      'Nearby context:',
      quoteBlock(comment.context),
      '',
      'Requested change:',
      comment.note,
    ];
    return lines.join('\n');
  });

  return [
    'Please revise the proposed plan using the feedback below. Stay in plan mode and do not implement yet.',
    '',
    ...sections.flatMap((section, index) => (index === 0 ? [section] : ['', section])),
  ].join('\n');
}

function quoteBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildContext(plan: string, quote: string): string {
  const normalizedPlan = compactWhitespace(plan);
  const normalizedQuote = compactWhitespace(quote);
  const index = normalizedPlan.toLowerCase().indexOf(normalizedQuote.toLowerCase());
  if (index === -1) return normalizedQuote;
  const start = Math.max(0, index - 140);
  const end = Math.min(normalizedPlan.length, index + normalizedQuote.length + 140);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalizedPlan.length ? '...' : '';
  return `${prefix}${normalizedPlan.slice(start, end)}${suffix}`;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
