import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronLeft, lucideX } from '@ng-icons/lucide';
import { MarkdownPipe } from '../pipes/markdown.pipe';

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskUserQuestion {
  id?: string;
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
}

@Component({
  selector: 'cw-ask-user-question-flow',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, MarkdownPipe],
  viewProviders: [provideIcons({ lucideCheck, lucideChevronLeft, lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cw-ask">
      <div class="cw-ask__nav">
        <span class="cw-ask__progress">{{ progressLabel() }}</span>
      </div>

      @if (isReviewing()) {
        <section class="cw-ask__recap" aria-label="Review answers">
          @for (question of questions(); track questionKey(question)) {
            <div class="cw-ask__recap-item">
              <span class="cw-ask__recap-question">{{ question.question }}</span>
              <span class="cw-ask__recap-answer">{{ serializeAnswer(question) }}</span>
            </div>
          }
        </section>
      } @else if (activeQuestion(); as question) {
        <section class="cw-ask__q">
          <div class="cw-ask__qhead">
            @if (question.header) {
              <span class="cw-ask__chip">{{ question.header }}</span>
            }
            <span class="cw-ask__qtext">{{ question.question }}</span>
          </div>

          <div class="cw-ask__options">
            @for (option of question.options; track option.label) {
              <label
                class="cw-ask__opt"
                [class.cw-ask__opt--on]="isSelected(question, option.label)"
              >
                <input
                  [type]="question.multiSelect ? 'checkbox' : 'radio'"
                  [name]="questionKey(question)"
                  [checked]="isSelected(question, option.label)"
                  (change)="toggleOption(question, option.label, $any($event.target).checked)"
                />
                <span class="cw-ask__opt-body">
                  <span class="cw-ask__opt-label">{{ option.label }}</span>
                  @if (option.description) {
                    <span class="cw-ask__opt-desc">{{ option.description }}</span>
                  }
                </span>
              </label>
            }

            <label class="cw-ask__opt" [class.cw-ask__opt--on]="isOtherSelected(question)">
              <input
                [type]="question.multiSelect ? 'checkbox' : 'radio'"
                [name]="questionKey(question)"
                [checked]="isOtherSelected(question)"
                (change)="toggleOther(question, $any($event.target).checked)"
              />
              <span class="cw-ask__opt-body">
                <span class="cw-ask__opt-label">Other...</span>
              </span>
            </label>

            @if (isOtherSelected(question)) {
              <textarea
                #otherTa
                class="cw-ask__other"
                [ngModel]="otherAnswers()[questionKey(question)] || ''"
                (ngModelChange)="setOtherAnswer(questionKey(question), $event)"
                placeholder="Type your answer"
              ></textarea>
            }
          </div>

          @if (selectedPreview(question); as preview) {
            <div class="cw-ask__preview" [innerHTML]="preview | cwMarkdown"></div>
          }
        </section>
      }

      <footer class="cw-ask__actions">
        <button type="button" class="cw-btn cw-btn--deny" (click)="decline.emit()">
          <ng-icon name="lucideX" size="13" aria-hidden="true" />
          {{ declineLabel() }}
        </button>
        <span class="cw-ask__spacer"></span>
        @if (canGoBack()) {
          <button type="button" class="cw-btn cw-btn--secondary" (click)="goBack()">
            <ng-icon name="lucideChevronLeft" size="13" aria-hidden="true" />
            Back
          </button>
        }
        @if (showNextButton()) {
          <button
            type="button"
            class="cw-btn cw-btn--primary"
            [disabled]="!canAdvanceActiveQuestion()"
            (click)="advance()"
          >
            <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
            Next
          </button>
        }
        @if (isReviewing()) {
          <button
            type="button"
            class="cw-btn cw-btn--primary"
            [disabled]="!canSubmit()"
            (click)="submit()"
          >
            <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
            {{ submitLabel() }}
          </button>
        }
      </footer>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-ask {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        margin-top: 0.15rem;
      }
      .cw-ask__nav {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-height: 1rem;
      }
      .cw-ask__progress {
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-ask__q {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .cw-ask__qhead {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
      }
      .cw-ask__chip {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--muted-foreground);
      }
      .cw-ask__qtext {
        font-size: 0.83rem;
        font-weight: 600;
        line-height: 1.4;
        color: var(--foreground);
      }
      .cw-ask__options {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .cw-ask__opt {
        display: flex;
        align-items: flex-start;
        gap: 0.55rem;
        padding: 0.45rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        cursor: pointer;
        transition:
          border-color 120ms ease,
          background 120ms ease;
      }
      .cw-ask__opt:hover {
        border-color: color-mix(in oklab, var(--foreground) 25%, var(--border));
      }
      .cw-ask__opt input {
        margin-top: 0.18rem;
        accent-color: var(--foreground);
      }
      .cw-ask__opt--on {
        border-color: var(--foreground);
        background: color-mix(in oklab, var(--foreground) 5%, var(--background));
      }
      .cw-ask__opt-body {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        min-width: 0;
      }
      .cw-ask__opt-label {
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--foreground);
      }
      .cw-ask__opt-desc {
        font-size: 0.72rem;
        color: var(--muted-foreground);
        line-height: 1.45;
      }
      .cw-ask__other {
        min-height: 3.5rem;
        padding: 0.5rem 0.65rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.8125rem;
        resize: vertical;
        outline: none;
        transition:
          border-color 120ms ease,
          box-shadow 120ms ease;
      }
      .cw-ask__other:focus {
        border-color: color-mix(in oklab, var(--ring) 60%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 25%, transparent);
      }
      .cw-ask__preview,
      .cw-ask__recap {
        max-height: 12rem;
        overflow: auto;
      }
      .cw-ask__preview {
        margin: 0.2rem 0 0;
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
        font-size: 0.8125rem;
        line-height: 1.6;
        white-space: pre-wrap;
      }
      .cw-ask__recap {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .cw-ask__recap-item {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
        gap: 0.5rem;
        align-items: start;
        padding: 0.45rem 0.55rem;
        border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
        border-radius: 0.45rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
      }
      .cw-ask__recap-question {
        min-width: 0;
        color: var(--muted-foreground);
        font-size: 0.74rem;
        line-height: 1.35;
      }
      .cw-ask__recap-answer {
        min-width: 0;
        color: var(--foreground);
        font-size: 0.78rem;
        font-weight: 500;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .cw-ask__actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
        margin-top: 0.35rem;
      }
      .cw-ask__spacer {
        flex: 1;
      }
      .cw-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        line-height: 1;
        padding: 0.4rem 0.75rem;
        border-radius: 0.45rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
        cursor: pointer;
        white-space: nowrap;
        transition:
          background 120ms ease,
          border-color 120ms ease,
          color 120ms ease,
          transform 80ms ease;
      }
      .cw-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 35%, transparent);
      }
      .cw-btn:active:not(:disabled) {
        transform: translateY(0.5px);
      }
      .cw-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .cw-btn ng-icon {
        flex-shrink: 0;
        opacity: 0.85;
      }
      .cw-btn--primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-btn--primary:hover:not(:disabled) {
        background: color-mix(in oklab, var(--primary) 88%, var(--background));
        border-color: color-mix(in oklab, var(--primary) 88%, var(--background));
      }
      .cw-btn--secondary {
        background: var(--secondary, color-mix(in oklab, var(--foreground) 6%, var(--background)));
        color: var(--secondary-foreground, var(--foreground));
        border-color: transparent;
      }
      .cw-btn--secondary:hover:not(:disabled) {
        background: color-mix(in oklab, var(--foreground) 10%, var(--background));
      }
      .cw-btn--deny {
        background: transparent;
        color: var(--muted-foreground);
        border-color: transparent;
        padding-left: 0.55rem;
        padding-right: 0.55rem;
      }
      .cw-btn--deny:hover:not(:disabled) {
        background: color-mix(in oklab, var(--destructive) 9%, transparent);
        color: var(--destructive);
      }

      @media (max-width: 540px) {
        .cw-ask__spacer {
          display: none;
        }
        .cw-btn {
          flex: 1;
        }
        .cw-ask__recap-item {
          grid-template-columns: 1fr;
          gap: 0.2rem;
        }
      }
    `,
  ],
})
export class AskUserQuestionFlowComponent {
  @ViewChild('otherTa') private otherTa?: ElementRef<HTMLTextAreaElement>;

  readonly requestId = input.required<string>();
  readonly questions = input.required<AskUserQuestion[]>();
  readonly declineLabel = input('Decline');
  readonly submitLabel = input('Submit');
  readonly submitted = output<Record<string, string>>();
  readonly decline = output<void>();

  readonly currentQuestionIndex = signal(0);
  readonly selectedAnswers = signal<Record<string, string[]>>({});
  readonly otherAnswers = signal<Record<string, string>>({});

  readonly isReviewing = computed(() => {
    const questions = this.questions();
    return questions.length > 0 && this.currentQuestionIndex() >= questions.length;
  });

  readonly activeQuestion = computed<AskUserQuestion | null>(() => {
    const questions = this.questions();
    if (!questions.length || this.isReviewing()) return null;
    return questions[this.currentQuestionIndex()] ?? null;
  });

  readonly progressLabel = computed(() => {
    const questions = this.questions();
    if (!questions.length) return 'No questions';
    if (this.isReviewing()) return 'Review answers';
    return `Question ${this.currentQuestionIndex() + 1} of ${questions.length}`;
  });

  private lastRequestId = '';

  constructor() {
    effect(() => {
      const requestId = this.requestId();
      if (requestId === this.lastRequestId) return;
      this.lastRequestId = requestId;
      this.selectedAnswers.set({});
      this.otherAnswers.set({});
      this.currentQuestionIndex.set(0);
    });
  }

  questionKey(question: AskUserQuestion): string {
    return question.id?.trim() || question.question;
  }

  isSelected(question: AskUserQuestion, label: string): boolean {
    return (this.selectedAnswers()[this.questionKey(question)] ?? []).includes(label);
  }

  isOtherSelected(question: AskUserQuestion): boolean {
    return (this.selectedAnswers()[this.questionKey(question)] ?? []).includes('__other__');
  }

  toggleOption(question: AskUserQuestion, label: string, checked: boolean): void {
    const key = this.questionKey(question);
    this.selectedAnswers.update((current) => ({
      ...current,
      [key]: nextSelections(current[key] ?? [], label, checked, !!question.multiSelect),
    }));
    if (checked && !question.multiSelect) {
      this.advance();
    }
  }

  toggleOther(question: AskUserQuestion, checked: boolean): void {
    const key = this.questionKey(question);
    this.selectedAnswers.update((current) => ({
      ...current,
      [key]: nextSelections(current[key] ?? [], '__other__', checked, !!question.multiSelect),
    }));
    if (checked) {
      queueMicrotask(() => this.otherTa?.nativeElement?.focus());
    }
  }

  setOtherAnswer(questionKey: string, value: string): void {
    this.otherAnswers.update((current) => ({ ...current, [questionKey]: value }));
  }

  selectedPreview(question: AskUserQuestion): string {
    if (question.multiSelect) return '';
    const selected = (this.selectedAnswers()[this.questionKey(question)] ?? []).find(
      (value) => value !== '__other__',
    );
    if (!selected) return '';
    return question.options.find((option) => option.label === selected)?.preview ?? '';
  }

  canGoBack(): boolean {
    return this.currentQuestionIndex() > 0;
  }

  goBack(): void {
    this.currentQuestionIndex.update((index) => Math.max(index - 1, 0));
  }

  canAdvanceActiveQuestion(): boolean {
    const question = this.activeQuestion();
    return !!question && this.canAdvanceQuestion(question);
  }

  showNextButton(): boolean {
    const question = this.activeQuestion();
    if (!question) return false;
    return (this.selectedAnswers()[this.questionKey(question)] ?? []).length > 0;
  }

  advance(): void {
    const question = this.activeQuestion();
    if (!question || !this.canAdvanceQuestion(question)) return;
    const questions = this.questions();
    this.currentQuestionIndex.set(Math.min(this.currentQuestionIndex() + 1, questions.length));
  }

  canSubmit(): boolean {
    return this.questions().every((question) => this.canAdvanceQuestion(question));
  }

  submit(): void {
    if (!this.isReviewing() || !this.canSubmit()) return;
    this.submitted.emit(
      Object.fromEntries(
        this.questions().map((question) => [
          this.questionKey(question),
          this.serializeAnswer(question),
        ]),
      ),
    );
  }

  serializeAnswer(question: AskUserQuestion): string {
    const key = this.questionKey(question);
    const mapped = (this.selectedAnswers()[key] ?? []).map((selection) =>
      selection === '__other__' ? (this.otherAnswers()[key] ?? '').trim() : selection,
    );
    return mapped.filter(Boolean).join(', ');
  }

  private canAdvanceQuestion(question: AskUserQuestion): boolean {
    const key = this.questionKey(question);
    const selections = this.selectedAnswers()[key] ?? [];
    if (selections.length === 0) return false;
    if (selections.includes('__other__')) {
      return !!this.otherAnswers()[key]?.trim();
    }
    return true;
  }
}

function nextSelections(
  current: string[],
  value: string,
  checked: boolean,
  multiSelect: boolean,
): string[] {
  if (!multiSelect) {
    return checked ? [value] : [];
  }
  const without = current.filter((entry) => entry !== value);
  return checked ? [...without, value] : without;
}
