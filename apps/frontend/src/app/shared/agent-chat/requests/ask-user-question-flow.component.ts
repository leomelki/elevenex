import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import { CommonModule } from '@angular/common';
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
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideChevronLeft, lucideX } from '@ng-icons/lucide';

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
  imports: [
    ZardButtonComponent,
    ZardInputDirective,
    CommonModule,
    FormsModule,
    NgIcon,
    AgentMarkdownComponent,
  ],
  viewProviders: [provideIcons({ lucideCheck, lucideChevronLeft, lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  templateUrl: './ask-user-question-flow.component.html',
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
    return (
      question.options.length === 0 ||
      (this.selectedAnswers()[this.questionKey(question)] ?? []).includes('__other__')
    );
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
    return (
      this.isOtherSelected(question) ||
      (this.selectedAnswers()[this.questionKey(question)] ?? []).length > 0
    );
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
    if (question.options.length === 0) return (this.otherAnswers()[key] ?? '').trim();
    const mapped = (this.selectedAnswers()[key] ?? []).map((selection) =>
      selection === '__other__' ? (this.otherAnswers()[key] ?? '').trim() : selection,
    );
    return mapped.filter(Boolean).join(', ');
  }

  private canAdvanceQuestion(question: AskUserQuestion): boolean {
    const key = this.questionKey(question);
    const selections = this.selectedAnswers()[key] ?? [];
    if (this.isOtherSelected(question)) {
      return !!this.otherAnswers()[key]?.trim();
    }
    return selections.length > 0;
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
