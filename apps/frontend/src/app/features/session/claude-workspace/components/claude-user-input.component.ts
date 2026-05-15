import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideBraces, lucideMessageCircleQuestion } from '@ng-icons/lucide';
import { ClaudeJsonSchema, ClaudeUserInputRequest } from '@/shared/models/claude-runtime.model';
import { AskUserQuestionFlowComponent } from './ask-user-question-flow.component';

interface Field {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  type: 'string' | 'textarea' | 'number' | 'boolean' | 'enum';
  options: string[];
}

@Component({
  selector: 'cw-user-input',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, AskUserQuestionFlowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideExternalLink, lucideBraces, lucideMessageCircleQuestion })],
  template: `
    <div class="cw-ui">
      <div class="cw-ui__head">
        <ng-icon
          [name]="askQuestions().length ? 'lucideMessageCircleQuestion' : 'lucideBraces'"
          size="14"
        />
        <strong>{{ request().title || request().displayName || request().serverName }}</strong>
        @if (request().description || request().message) {
          <span class="cw-ui__desc">{{ request().description || request().message }}</span>
        }
      </div>

      @if (askQuestions().length) {
        <cw-ask-user-question-flow
          [requestId]="request().requestId"
          [questions]="askQuestions()"
          declineLabel="Decline"
          submitLabel="Submit"
          (decline)="answer.emit({ action: 'decline' })"
          (submitted)="submitQuestionAnswers($event)"
        />
      } @else if (request().mode === 'url' && request().url) {
        <a class="cw-ui__link" [href]="request().url" target="_blank" rel="noreferrer">
          <ng-icon name="lucideExternalLink" size="14" />
          Open requested URL
        </a>
      } @else if (fields().length) {
        <div class="cw-ui__grid">
          @for (field of fields(); track field.key) {
            <label class="cw-ui__field">
              <span class="cw-ui__label">
                {{ field.label }}
                @if (field.required) {
                  <em>*</em>
                }
              </span>
              @switch (field.type) {
                @case ('boolean') {
                  <input
                    type="checkbox"
                    [ngModel]="!!values()[field.key]"
                    (ngModelChange)="set(field.key, $event)"
                  />
                }
                @case ('enum') {
                  <select
                    [ngModel]="values()[field.key] ?? ''"
                    (ngModelChange)="set(field.key, $event)"
                  >
                    <option value="">Select…</option>
                    @for (opt of field.options; track opt) {
                      <option [value]="opt">{{ opt }}</option>
                    }
                  </select>
                }
                @case ('number') {
                  <input
                    type="number"
                    [ngModel]="values()[field.key] ?? ''"
                    (ngModelChange)="set(field.key, $event === '' ? '' : Number($event))"
                  />
                }
                @case ('textarea') {
                  <textarea
                    [ngModel]="values()[field.key] ?? ''"
                    (ngModelChange)="set(field.key, $event)"
                  ></textarea>
                }
                @default {
                  <input
                    type="text"
                    [ngModel]="values()[field.key] ?? ''"
                    (ngModelChange)="set(field.key, $event)"
                  />
                }
              }
              @if (field.description) {
                <span class="cw-ui__help">{{ field.description }}</span>
              }
            </label>
          }
        </div>
      } @else {
        <textarea
          class="cw-ui__json"
          [ngModel]="jsonText()"
          (ngModelChange)="onJsonInput($event)"
          placeholder="{}"
        ></textarea>
        @if (jsonError()) {
          <div class="cw-ui__error">{{ jsonError() }}</div>
        }
      }

      @if (!askQuestions().length) {
        <div class="cw-ui__actions">
          <button type="button" class="cw-ui__btn" (click)="answer.emit({ action: 'cancel' })">
            Cancel
          </button>
          <button type="button" class="cw-ui__btn" (click)="answer.emit({ action: 'decline' })">
            Decline
          </button>
          <button type="button" class="cw-ui__btn cw-ui__btn--primary" (click)="submit()">
            Accept
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-ui {
        border: 1px solid var(--border);
        border-radius: 0.625rem;
        background: var(--card);
        padding: 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        font-size: 0.8125rem;
      }
      .cw-ui__head {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-wrap: wrap;
      }
      .cw-ui__desc {
        color: var(--muted-foreground);
        font-weight: 400;
      }
      .cw-ui__grid {
        display: grid;
        gap: 0.5rem;
      }
      .cw-ui__field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.75rem;
      }
      .cw-ui__label {
        font-weight: 600;
      }
      .cw-ui__label em {
        color: var(--destructive);
        font-style: normal;
      }
      .cw-ui__help {
        color: var(--muted-foreground);
      }
      .cw-ui__field input[type='text'],
      .cw-ui__field input[type='number'],
      .cw-ui__field select,
      .cw-ui__field textarea,
      .cw-ui__json {
        padding: 0.375rem 0.5rem;
        border: 1px solid var(--border);
        border-radius: 0.375rem;
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.8125rem;
      }
      .cw-ui__json {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 5rem;
      }
      .cw-ui__link {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        color: var(--primary);
        text-decoration: underline;
        font-size: 0.8125rem;
      }
      .cw-ui__error {
        color: var(--destructive);
        font-size: 0.75rem;
      }
      .cw-ui__actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.375rem;
      }
      .cw-ui__btn {
        padding: 0.3125rem 0.75rem;
        border-radius: 0.375rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: inherit;
        font: inherit;
        cursor: pointer;
        font-size: 0.75rem;
        font-weight: 500;
      }
      .cw-ui__btn--primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-ui__btn:hover {
        filter: brightness(0.97);
      }
    `,
  ],
})
export class ClaudeUserInputComponent {
  readonly request = input.required<ClaudeUserInputRequest>();
  readonly answer = output<{
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }>();

  readonly fields = computed<Field[]>(() => buildFields(this.request().requestedSchema));
  readonly askQuestions = computed(() => this.request().questions ?? []);
  readonly values = signal<Record<string, unknown>>({});
  readonly jsonText = signal('{}');
  readonly jsonError = signal<string | null>(null);
  readonly Number = Number;

  private lastRequestId = '';

  constructor() {
    effect(() => {
      const r = this.request();
      if (r.requestId === this.lastRequestId) return;
      this.lastRequestId = r.requestId;
      const initial: Record<string, unknown> = {};
      for (const f of buildFields(r.requestedSchema)) {
        initial[f.key] = f.type === 'boolean' ? false : '';
      }
      this.values.set(initial);
      this.jsonText.set(JSON.stringify(initial, null, 2));
      this.jsonError.set(null);
    });
  }

  set(key: string, value: unknown): void {
    this.values.update((v) => ({ ...v, [key]: value }));
    this.jsonText.set(JSON.stringify(this.values(), null, 2));
    this.jsonError.set(null);
  }

  onJsonInput(text: string): void {
    this.jsonText.set(text);
    this.jsonError.set(null);
  }

  submit(): void {
    if (this.fields().length) {
      this.answer.emit({ action: 'accept', content: this.values() });
      return;
    }
    try {
      const parsed = JSON.parse(this.jsonText() || '{}');
      this.answer.emit({ action: 'accept', content: parsed });
    } catch {
      this.jsonError.set('Provide valid JSON before accepting.');
    }
  }

  submitQuestionAnswers(answers: Record<string, string>): void {
    this.answer.emit({ action: 'accept', content: answers });
  }
}

function buildFields(schema: ClaudeJsonSchema | undefined): Field[] {
  if (!schema || schema.type !== 'object' || !schema.properties) return [];
  const required = schema.required ?? [];
  const out: Field[] = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    const rawType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const label = prop.title || key;
    const description = prop.description;
    const isReq = required.includes(key);
    if (prop.enum && prop.enum.length) {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: 'enum',
        options: prop.enum.map(String),
      });
      continue;
    }
    if (rawType === 'boolean') {
      out.push({ key, label, description, required: isReq, type: 'boolean', options: [] });
      continue;
    }
    if (rawType === 'number' || rawType === 'integer') {
      out.push({ key, label, description, required: isReq, type: 'number', options: [] });
      continue;
    }
    if (!rawType || rawType === 'string') {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: prop.format === 'multiline' ? 'textarea' : 'string',
        options: [],
      });
    }
  }
  return out;
}
