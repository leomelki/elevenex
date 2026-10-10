import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardCheckboxComponent } from '@/shared/components/checkbox';
import { AskUserQuestionFlowComponent } from '@/shared/agent-chat/requests/ask-user-question-flow.component';
import { AgentJsonSchema, AgentUserInputRequest } from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBraces, lucideExternalLink, lucideMessageCircleQuestion } from '@ng-icons/lucide';

interface Field {
  key: string;
  label: string;
  description?: string;
  required: boolean;
  type: 'string' | 'textarea' | 'number' | 'boolean' | 'enum' | 'multiselect';
  options: string[];
  defaultValue?: unknown;
}

@Component({
  selector: 'cw-user-input',
  standalone: true,
  imports: [
    ZardButtonComponent,
    ZardInputDirective,
    ZardCheckboxComponent,
    CommonModule,
    FormsModule,
    NgIcon,
    AskUserQuestionFlowComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideExternalLink, lucideBraces, lucideMessageCircleQuestion })],
  templateUrl: './claude-user-input.component.html',
})
export class ClaudeUserInputComponent {
  readonly request = input.required<AgentUserInputRequest>();
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
        initial[f.key] =
          f.defaultValue ?? (f.type === 'boolean' ? false : f.type === 'multiselect' ? [] : '');
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

  isSelected(key: string, option: string): boolean {
    const value = this.values()[key];
    return Array.isArray(value) && value.includes(option);
  }

  toggleOption(key: string, option: string, checked: boolean): void {
    const value = this.values()[key];
    const selected = Array.isArray(value) ? value.filter((item) => item !== option) : [];
    this.set(key, checked ? [...selected, option] : selected);
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

  submitQuestionAnswers(answers: Record<string, string | string[]>): void {
    this.answer.emit({ action: 'accept', content: answers });
  }
}

function buildFields(schema: AgentJsonSchema | undefined): Field[] {
  if (!schema || schema.type !== 'object' || !schema.properties) return [];
  const required = schema.required ?? [];
  const out: Field[] = [];
  for (const [key, prop] of Object.entries(schema.properties)) {
    const rawType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    const label = prop.title || key;
    const description = prop.description;
    const isReq = required.includes(key);
    if (rawType === 'array' && prop.items?.enum) {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: 'multiselect',
        options: prop.items.enum.map(String),
        defaultValue: prop.default,
      });
      continue;
    }
    if (prop.enum && prop.enum.length) {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: 'enum',
        options: prop.enum.map(String),
        defaultValue: prop.default,
      });
      continue;
    }
    if (rawType === 'boolean') {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: 'boolean',
        options: [],
        defaultValue: prop.default,
      });
      continue;
    }
    if (rawType === 'number' || rawType === 'integer') {
      out.push({
        key,
        label,
        description,
        required: isReq,
        type: 'number',
        options: [],
        defaultValue: prop.default,
      });
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
        defaultValue: prop.default,
      });
    }
  }
  return out;
}
