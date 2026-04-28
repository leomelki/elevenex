import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ClaudePermissionApproval, ClaudePermissionRequest } from '@/shared/models/claude-runtime.model';
import { MarkdownPipe } from '../pipes/markdown.pipe';
import { DiffSegment, normalizeToolName as normalizeToolNameForUi, simpleLineDiff } from '../util/tool-format';

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

@Component({
  selector: 'cw-permission-inline',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cw-perm" [attr.data-kind]="kind()" [class.cw-perm--dock]="appearance() === 'dock'">
      @switch (kind()) {
        @case ('ask_user_question') {
          <div class="cw-perm__copy">
            <strong>{{ request().title || 'Claude needs your input' }}</strong>
            <span class="cw-perm__desc">{{ request().description || 'Choose an option for each question.' }}</span>
          </div>

          <div class="cw-ask">
            @for (question of questions(); track question.question) {
              <section class="cw-ask__question">
                <div class="cw-ask__head">
                  @if (question.header) {
                    <span class="cw-ask__chip">{{ question.header }}</span>
                  }
                  <strong>{{ question.question }}</strong>
                </div>

                <div class="cw-ask__options">
                  @for (option of question.options; track option.label) {
                    <label class="cw-ask__option" [class.cw-ask__option--selected]="isSelected(question, option.label)">
                      <input
                        [type]="question.multiSelect ? 'checkbox' : 'radio'"
                        [name]="question.question"
                        [checked]="isSelected(question, option.label)"
                        (change)="toggleOption(question, option.label, $any($event.target).checked)"
                      />
                      <span class="cw-ask__option-body">
                        <span class="cw-ask__option-label">{{ option.label }}</span>
                        @if (option.description) {
                          <span class="cw-ask__option-desc">{{ option.description }}</span>
                        }
                      </span>
                    </label>
                  }

                  <label class="cw-ask__option" [class.cw-ask__option--selected]="isOtherSelected(question)">
                    <input
                      [type]="question.multiSelect ? 'checkbox' : 'radio'"
                      [name]="question.question"
                      [checked]="isOtherSelected(question)"
                      (change)="toggleOther(question, $any($event.target).checked)"
                    />
                    <span class="cw-ask__option-body">
                      <span class="cw-ask__option-label">Other</span>
                      <span class="cw-ask__option-desc">Provide a custom answer.</span>
                    </span>
                  </label>

                  @if (isOtherSelected(question)) {
                    <textarea
                      class="cw-ask__other"
                      [ngModel]="otherAnswers()[question.question] || ''"
                      (ngModelChange)="setOtherAnswer(question.question, $event)"
                      placeholder="Type your answer"
                    ></textarea>
                  }
                </div>

                @if (selectedPreview(question); as preview) {
                  <div class="cw-ask__preview" [innerHTML]="preview | cwMarkdown"></div>
                }
              </section>
            }
          </div>

          <div class="cw-perm__actions">
            <button type="button" class="cw-perm__btn cw-perm__btn--deny" (click)="deny.emit()">Decline</button>
            <button
              type="button"
              class="cw-perm__btn cw-perm__btn--primary"
              [disabled]="!canSubmitQuestions()"
              (click)="submitQuestions()"
            >
              Submit answers
            </button>
          </div>
        }
        @case ('enter_plan_mode') {
          <div class="cw-perm__copy">
            <strong>{{ request().title || 'Enter plan mode?' }}</strong>
            <span class="cw-perm__desc">
              Claude will stay read-only, explore the codebase, and prepare an implementation plan before editing.
            </span>
          </div>
          <div class="cw-perm__actions">
            <button type="button" class="cw-perm__btn cw-perm__btn--deny" (click)="deny.emit()">Not now</button>
            <button type="button" class="cw-perm__btn cw-perm__btn--primary" (click)="approve.emit({ remember: false })">
              Start planning
            </button>
          </div>
        }
        @case ('exit_plan_mode') {
          <div class="cw-perm__copy">
            <strong>{{ request().title || 'Approve plan?' }}</strong>
            <span class="cw-perm__desc">
              Review Claude’s implementation plan before leaving plan mode.
            </span>
            @if (planPath(); as path) {
              <span class="cw-perm__path">{{ path }}</span>
            }
          </div>

          @if (planContent(); as plan) {
            <div class="cw-plan" [innerHTML]="plan | cwMarkdown"></div>
          }

          <div class="cw-perm__actions">
            <button type="button" class="cw-perm__btn cw-perm__btn--deny" (click)="deny.emit()">Keep planning</button>
            <button type="button" class="cw-perm__btn cw-perm__btn--primary" (click)="approve.emit({ remember: false })">
              Approve plan
            </button>
          </div>
        }
        @default {
          <div class="cw-perm__hero">
            <div class="cw-perm__eyebrow">
              <span class="cw-perm__eyebrow-pill">{{ sourceLabel() }}</span>
              <span class="cw-perm__eyebrow-copy">Approval required</span>
            </div>
            <div class="cw-perm__copy">
              <strong>{{ requestTitle() }}</strong>
              <span class="cw-perm__desc">{{ requestSubtitle() }}</span>
            </div>
          </div>
          <div class="cw-perm__grid">
            <section class="cw-perm__section">
              <span class="cw-perm__section-label">Request</span>
              <div class="cw-perm__meta">
                <div class="cw-perm__meta-row">
                  <span class="cw-perm__meta-key">Tool</span>
                  <span class="cw-perm__meta-value">{{ requestToolLabel() }}</span>
                </div>
                <div class="cw-perm__meta-row">
                  <span class="cw-perm__meta-key">Scope</span>
                  <span class="cw-perm__meta-value">{{ sourceScopeCopy() }}</span>
                </div>
                @if (request().blockedPath) {
                  <div class="cw-perm__meta-row">
                    <span class="cw-perm__meta-key">Path</span>
                    <span class="cw-perm__meta-value cw-perm__meta-value--mono">{{ request().blockedPath }}</span>
                  </div>
                }
              </div>
            </section>

            <section class="cw-perm__section">
              <span class="cw-perm__section-label">Why Claude is asking</span>
              <div class="cw-perm__reasons">
                @for (reason of requestReasons(); track reason) {
                  <p class="cw-perm__reason">{{ reason }}</p>
                }
              </div>
            </section>
          </div>
          @if (permDiffSegments().length) {
            <pre class="cw-perm__diff">@for (seg of permDiffSegments(); track $index) {<span [class]="'cw-diff-' + seg.type">{{ permDiffPrefix(seg.type) }}{{ seg.text }}
</span>}</pre>
          }
          @if (permWriteContent()) {
            <pre class="cw-perm__file">{{ permWriteContent() }}</pre>
          }
          @if (permBashCommand()) {
            <pre class="cw-perm__cmd">$ {{ permBashCommand() }}</pre>
          }
          <section class="cw-perm__section cw-perm__section--decision">
            <span class="cw-perm__section-label">What happens if you approve</span>
            <div class="cw-perm__decision-copy">
              <p class="cw-perm__reason">{{ allowOnceCopy() }}</p>
              <p class="cw-perm__reason">{{ allowAlwaysCopy() }}</p>
            </div>
          </section>
          <div class="cw-perm__actions">
            <button type="button" class="cw-perm__btn cw-perm__btn--deny" (click)="deny.emit()">Deny</button>
            <button type="button" class="cw-perm__btn" (click)="approve.emit({ remember: false })">Allow once</button>
            <button type="button" class="cw-perm__btn cw-perm__btn--primary" (click)="approve.emit({ remember: true })">
              Always
            </button>
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-perm {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 0.75rem;
        border-top: 1px solid color-mix(in oklab, #f59e0b 30%, var(--border));
        background: color-mix(in oklab, #f59e0b 7%, transparent);
        font-size: 0.75rem;
      }
      .cw-perm--dock {
        gap: 0.85rem;
        padding: 0.9rem 1rem 0.95rem;
        border: 1px solid color-mix(in oklab, #f59e0b 40%, var(--border));
        border-bottom: 0;
        border-radius: 0.95rem 0.95rem 0 0;
        background:
          linear-gradient(
            180deg,
            color-mix(in oklab, #f59e0b 11%, var(--card)) 0%,
            color-mix(in oklab, var(--card) 96%, var(--background)) 100%
          );
        box-shadow: 0 14px 38px -28px color-mix(in oklab, #000 38%, transparent);
      }
      .cw-perm__hero {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cw-perm__eyebrow {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .cw-perm__eyebrow-pill {
        display: inline-flex;
        align-items: center;
        padding: 0.16rem 0.5rem;
        border-radius: 999px;
        background: color-mix(in oklab, #f59e0b 14%, transparent);
        color: color-mix(in oklab, #b45309 85%, var(--foreground));
        border: 1px solid color-mix(in oklab, #f59e0b 24%, transparent);
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .cw-perm__eyebrow-copy {
        color: var(--muted-foreground);
        font-size: 0.7rem;
        font-weight: 600;
      }
      .cw-perm__copy {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
      }
      .cw-perm__copy strong {
        font-size: 0.92rem;
        line-height: 1.3;
      }
      .cw-perm__path {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--muted-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cw-perm__desc {
        color: var(--muted-foreground);
        line-height: 1.5;
      }
      .cw-perm__grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
      }
      .cw-perm__section {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-width: 0;
        padding: 0.7rem 0.75rem;
        border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
        border-radius: 0.7rem;
        background: color-mix(in oklab, var(--background) 88%, transparent);
      }
      .cw-perm__section--decision {
        padding-top: 0.75rem;
      }
      .cw-perm__section-label {
        font-size: 0.67rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: color-mix(in oklab, var(--foreground) 45%, var(--muted-foreground));
      }
      .cw-perm__meta {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .cw-perm__meta-row {
        display: grid;
        grid-template-columns: 3.5rem 1fr;
        gap: 0.5rem;
        align-items: start;
      }
      .cw-perm__meta-key {
        color: var(--muted-foreground);
        font-size: 0.72rem;
      }
      .cw-perm__meta-value {
        font-size: 0.78rem;
        line-height: 1.45;
        color: var(--foreground);
        word-break: break-word;
      }
      .cw-perm__meta-value--mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
      }
      .cw-perm__reasons,
      .cw-perm__decision-copy {
        display: flex;
        flex-direction: column;
        gap: 0.42rem;
      }
      .cw-perm__reason {
        margin: 0;
        font-size: 0.78rem;
        line-height: 1.5;
      }
      .cw-perm__diff,
      .cw-perm__file,
      .cw-perm__cmd {
        margin: 0;
        padding: 0.5rem 0.625rem;
        border-radius: 0.7rem;
        border: 1px solid var(--border);
        background: var(--background);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.6875rem;
        line-height: 1.5;
        overflow-x: auto;
        max-height: 14rem;
        overflow-y: auto;
        white-space: pre;
      }
      .cw-perm__diff .cw-diff-del {
        color: #ef4444;
        background: color-mix(in oklab, #ef4444 10%, transparent);
      }
      .cw-perm__diff .cw-diff-add {
        color: #22c55e;
        background: color-mix(in oklab, #22c55e 10%, transparent);
      }
      .cw-perm__diff .cw-diff-context {
        color: var(--muted-foreground);
      }
      .cw-perm__actions {
        display: flex;
        gap: 0.375rem;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .cw-perm__btn {
        padding: 0.375rem 0.75rem;
        border-radius: 0.375rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: inherit;
        font: inherit;
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 500;
      }
      .cw-perm__btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .cw-perm__btn:hover:not(:disabled) {
        background: color-mix(in oklab, var(--foreground) 5%, var(--background));
      }
      .cw-perm__btn--primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-perm__btn--primary:hover:not(:disabled) {
        opacity: 0.92;
      }
      .cw-perm__btn--deny {
        color: var(--destructive);
        border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
      }
      .cw-ask {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .cw-ask__question {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.625rem;
        border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--card) 92%, transparent);
      }
      .cw-ask__head {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-wrap: wrap;
      }
      .cw-ask__chip {
        padding: 0.125rem 0.375rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--muted-foreground);
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .cw-ask__options {
        display: grid;
        gap: 0.375rem;
      }
      .cw-ask__option {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.5rem;
        align-items: flex-start;
        padding: 0.5rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        cursor: pointer;
      }
      .cw-ask__option--selected {
        border-color: color-mix(in oklab, var(--primary) 55%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--background));
      }
      .cw-ask__option-body {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }
      .cw-ask__option-label {
        font-size: 0.8125rem;
        font-weight: 600;
      }
      .cw-ask__option-desc {
        color: var(--muted-foreground);
        font-size: 0.75rem;
        line-height: 1.45;
      }
      .cw-ask__other {
        min-height: 4.5rem;
        padding: 0.5rem 0.625rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        color: inherit;
        font: inherit;
        resize: vertical;
      }
      .cw-ask__preview,
      .cw-plan {
        padding: 0.625rem 0.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--border);
        background: color-mix(in oklab, var(--background) 92%, transparent);
        font-size: 0.8125rem;
        line-height: 1.6;
      }
      .cw-ask__preview {
        max-height: 18rem;
        overflow: auto;
      }
      .cw-plan {
        max-height: 22rem;
        overflow: auto;
      }
      @media (max-width: 720px) {
        .cw-perm__grid {
          grid-template-columns: 1fr;
        }
        .cw-perm__meta-row {
          grid-template-columns: 1fr;
          gap: 0.15rem;
        }
      }
      .cw-ask__preview :first-child,
      .cw-plan :first-child {
        margin-top: 0;
      }
      .cw-ask__preview :last-child,
      .cw-plan :last-child {
        margin-bottom: 0;
      }
    `,
  ],
})
export class ClaudePermissionInlineComponent {
  readonly request = input.required<ClaudePermissionRequest>();
  readonly appearance = input<'inline' | 'dock'>('inline');
  readonly approve = output<ClaudePermissionApproval>();
  readonly deny = output<void>();

  readonly kind = computed<'generic' | 'ask_user_question' | 'enter_plan_mode' | 'exit_plan_mode'>(() => {
    const name = normalizeToolName(this.request().toolName);
    if (name === 'askuserquestion') return 'ask_user_question';
    if (name === 'enterplanmode') return 'enter_plan_mode';
    if (name === 'exitplanmode') return 'exit_plan_mode';
    return 'generic';
  });

  readonly permToolKind = computed<string>(() => normalizeToolName(this.request().toolName));

  readonly sourceLabel = computed(() => (this.request().agentId ? 'Subagent request' : 'Claude request'));

  readonly requestTitle = computed(() => {
    const title = this.request().title?.trim();
    if (title) return title;
    const displayName = this.request().displayName?.trim();
    if (displayName) return displayName;
    return `Approve ${this.requestToolLabel()}`;
  });

  readonly requestSubtitle = computed(() => {
    const description = this.request().description?.trim();
    if (description) return description;
    return this.request().agentId
      ? 'A delegated subagent needs approval before it can continue.'
      : 'Claude needs approval before it can continue.';
  });

  readonly requestToolLabel = computed(() => {
    const displayName = this.request().displayName?.trim();
    if (displayName) return displayName;
    const toolName = this.request().toolName?.trim();
    return toolName || 'requested tool';
  });

  readonly sourceScopeCopy = computed(() =>
    this.request().agentId
      ? `Delegated agent ${this.request().agentId}`
      : 'Main Claude session',
  );

  readonly requestReasons = computed(() => {
    const reasons = [
      this.request().description?.trim(),
      this.request().decisionReason?.trim(),
      this.request().blockedPath ? `The current sandbox blocked access to ${this.request().blockedPath}.` : null,
    ].filter((value): value is string => !!value);
    if (reasons.length) return reasons;
    return ['This action needs explicit approval before Claude can continue.'];
  });

  readonly allowOnceCopy = computed(
    () => `Allow once lets ${this.request().agentId ? 'this subagent' : 'Claude'} perform this one action now.`,
  );

  readonly allowAlwaysCopy = computed(() =>
    this.request().suggestions?.length
      ? 'Always also applies the suggested permission rule so similar requests can proceed without asking again.'
      : 'Always saves a reusable permission decision for similar requests when the runtime supports it.',
  );

  readonly permDiffSegments = computed<DiffSegment[]>(() => {
    if (this.kind() !== 'generic') return [];
    const name = this.permToolKind();
    if (name !== 'edit' && name !== 'multiedit' && name !== 'fileedit' && name !== 'fileedittool') return [];
    const data = asRecord(this.request().input);
    const oldStr = typeof data['old_string'] === 'string' ? data['old_string'] : '';
    const newStr = typeof data['new_string'] === 'string' ? data['new_string'] : '';
    if (!oldStr && !newStr) return [];
    return simpleLineDiff(oldStr, newStr);
  });

  readonly permWriteContent = computed<string>(() => {
    if (this.kind() !== 'generic') return '';
    const name = this.permToolKind();
    if (name !== 'write' && name !== 'filewrite' && name !== 'filewritetool') return '';
    const data = asRecord(this.request().input);
    return typeof data['content'] === 'string' ? data['content'] : '';
  });

  readonly permBashCommand = computed<string>(() => {
    if (this.kind() !== 'generic') return '';
    const name = this.permToolKind();
    if (name !== 'bash' && name !== 'powershell') return '';
    const data = asRecord(this.request().input);
    return typeof data['command'] === 'string' ? String(data['command']).trim() : '';
  });

  readonly questions = computed<AskQuestion[]>(() => {
    if (this.kind() !== 'ask_user_question') return [];
    const input = asRecord(this.request().input);
    return Array.isArray(input['questions']) ? (input['questions'] as AskQuestion[]) : [];
  });

  readonly planContent = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['plan'] === 'string' ? input['plan'] : '';
  });

  readonly planPath = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['planFilePath'] === 'string' ? input['planFilePath'] : '';
  });

  readonly selectedAnswers = signal<Record<string, string[]>>({});
  readonly otherAnswers = signal<Record<string, string>>({});

  readonly canSubmitQuestions = computed(() =>
    this.questions().every((question) => {
      const selections = this.selectedAnswers()[question.question] ?? [];
      if (selections.length === 0) return false;
      if (selections.includes('__other__')) {
        return !!this.otherAnswers()[question.question]?.trim();
      }
      return true;
    }),
  );

  private lastRequestId = '';

  permDiffPrefix(type: 'context' | 'add' | 'del'): string {
    if (type === 'add') return '+ ';
    if (type === 'del') return '- ';
    return '  ';
  }

  constructor() {
    effect(() => {
      const requestId = this.request().requestId;
      if (requestId === this.lastRequestId) return;
      this.lastRequestId = requestId;
      this.selectedAnswers.set({});
      this.otherAnswers.set({});
    });
  }

  isSelected(question: AskQuestion, label: string): boolean {
    return (this.selectedAnswers()[question.question] ?? []).includes(label);
  }

  isOtherSelected(question: AskQuestion): boolean {
    return (this.selectedAnswers()[question.question] ?? []).includes('__other__');
  }

  toggleOption(question: AskQuestion, label: string, checked: boolean): void {
    this.selectedAnswers.update((current) => ({
      ...current,
      [question.question]: nextSelections(
        current[question.question] ?? [],
        label,
        checked,
        !!question.multiSelect,
      ),
    }));
  }

  toggleOther(question: AskQuestion, checked: boolean): void {
    this.selectedAnswers.update((current) => ({
      ...current,
      [question.question]: nextSelections(
        current[question.question] ?? [],
        '__other__',
        checked,
        !!question.multiSelect,
      ),
    }));
  }

  setOtherAnswer(questionText: string, value: string): void {
    this.otherAnswers.update((current) => ({ ...current, [questionText]: value }));
  }

  selectedPreview(question: AskQuestion): string {
    if (question.multiSelect) return '';
    const selected = (this.selectedAnswers()[question.question] ?? []).find((value) => value !== '__other__');
    if (!selected) return '';
    return question.options.find((option) => option.label === selected)?.preview ?? '';
  }

  submitQuestions(): void {
    if (!this.canSubmitQuestions()) return;
    const answers = Object.fromEntries(
      this.questions().map((question) => [question.question, this.serializeAnswer(question)]),
    );
    this.approve.emit({
      remember: false,
      content: { answers },
    });
  }

  private serializeAnswer(question: AskQuestion): string {
    const selections = this.selectedAnswers()[question.question] ?? [];
    const mapped = selections.map((selection) =>
      selection === '__other__' ? (this.otherAnswers()[question.question] ?? '').trim() : selection,
    );
    return mapped.filter(Boolean).join(', ');
  }
}

function normalizeToolName(name: string | undefined): string {
  return normalizeToolNameForUi(name ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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
