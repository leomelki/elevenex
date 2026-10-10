import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import {
  AskUserQuestion,
  AskUserQuestionFlowComponent,
} from '@/shared/agent-chat/requests/ask-user-question-flow.component';
import { highlightedDiffHtml } from '@/shared/agent-chat/tools/code-highlight';
import { normalizeToolName as normalizeToolNameForUi } from '@/shared/agent-tools/agent-tool-format';
import {
  AgentPermissionApproval,
  AgentPermissionRequest,
  AgentPermissionUpdate,
  AgentToolKind,
} from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCheckCheck,
  lucideClipboardList,
  lucideMessageCircleQuestion,
  lucideShield,
  lucideX,
} from '@ng-icons/lucide';
import DOMPurify from 'dompurify';

interface AlwaysAllowPattern {
  label: string;
  pattern: string;
  detail: string;
}

@Component({
  selector: 'cw-permission-inline',
  standalone: true,
  imports: [
    ZardButtonComponent,
    ZardInputDirective,
    CommonModule,
    FormsModule,
    NgIcon,
    AskUserQuestionFlowComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideShield,
      lucideMessageCircleQuestion,
      lucideClipboardList,
      lucideCheck,
      lucideCheckCheck,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  templateUrl: './claude-permission-inline.component.html',
  styleUrl: './claude-permission-inline.component.scss',
})
export class ClaudePermissionInlineComponent {
  @ViewChild('denyTa') private denyTa?: ElementRef<HTMLTextAreaElement>;

  readonly request = input.required<AgentPermissionRequest>();
  readonly appearance = input<'inline' | 'dock'>('inline');
  readonly planReviewAvailable = input(false);
  readonly approve = output<AgentPermissionApproval>();
  readonly deny = output<string | undefined>();
  readonly openPlanReview = output<void>();

  readonly denying = signal(false);
  readonly denyMessage = signal('');

  readonly kind = computed<'generic' | 'ask_user_question' | 'enter_plan_mode' | 'exit_plan_mode'>(
    () => {
      const canonicalKind = this.request().toolKind;
      if (canonicalKind === 'ask_user_question') return 'ask_user_question';
      if (canonicalKind === 'enter_plan_mode') return 'enter_plan_mode';
      if (canonicalKind === 'exit_plan_mode') return 'exit_plan_mode';
      const name = normalizeToolName(this.request().toolName);
      if (name === 'askuserquestion') return 'ask_user_question';
      if (name === 'enterplanmode') return 'enter_plan_mode';
      if (name === 'exitplanmode') return 'exit_plan_mode';
      return 'generic';
    },
  );

  readonly permToolKind = computed<AgentToolKind | string>(
    () => this.request().toolKind ?? normalizeToolName(this.request().toolName),
  );

  readonly requestTitle = computed(() => {
    const batchSize = this.request().batch?.length ?? 0;
    if (batchSize > 1) return `Approve ${batchSize} actions?`;
    const title = this.request().title?.trim();
    if (title) return title;
    const displayName = this.request().displayName?.trim();
    if (displayName) return `Allow ${displayName}?`;
    return `Approve ${this.requestToolLabel()}`;
  });

  readonly requestSubtitle = computed(() => {
    const description = this.request().description?.trim();
    return description || '';
  });

  readonly requestToolLabel = computed(() => {
    const toolDisplayName = this.request().toolDisplayName?.trim();
    if (toolDisplayName) return toolDisplayName;
    const displayName = this.request().displayName?.trim();
    if (displayName) return displayName;
    const toolName = this.request().toolName?.trim();
    return toolName || 'requested tool';
  });

  readonly requestSubline = computed(() => {
    const data = asRecord(this.request().input);
    const path =
      strField(data, 'file_path') ||
      strField(data, 'path') ||
      strField(data, 'notebook_path') ||
      strField(data, 'url') ||
      this.request().blockedPath ||
      '';
    return path;
  });

  readonly allowOnceCopy = computed(() => {
    const batchSize = this.request().batch?.length ?? 0;
    return batchSize > 1
      ? `Approve these ${batchSize} actions from this tool-call batch only.`
      : `Approve this single action only. ${this.request().agentId ? 'The subagent' : 'Claude'} will ask again next time.`;
  });

  readonly allowOnceLabel = computed(() => {
    const batchSize = this.request().batch?.length ?? 0;
    return batchSize > 1 ? `Allow ${batchSize} actions` : 'Allow once';
  });

  batchItemLabel(item: { toolDisplayName?: string; toolName: string }): string {
    return item.toolDisplayName?.trim() || normalizeToolNameForUi(item.toolName) || item.toolName;
  }

  batchItemTarget(item: { input: unknown }): string {
    const data = asRecord(item.input);
    for (const key of [
      'worktreePath',
      'worktree_path',
      'file_path',
      'path',
      'url',
      'query',
      'sessionId',
      'repoId',
    ]) {
      const value = data[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    try {
      const serialized = JSON.stringify(data);
      return serialized.length > 180 ? `${serialized.slice(0, 177)}…` : serialized;
    } catch {
      return '';
    }
  }

  readonly allowAlwaysCopy = computed(() =>
    this.request().suggestions?.length
      ? `Approve and save ${this.alwaysAllowPatterns().length ? 'the displayed pattern' : 'Claude’s suggested permission rule'} for similar requests.`
      : 'Approve this request, but Claude did not provide a reusable pattern to save.',
  );

  readonly alwaysAllowPatterns = computed<AlwaysAllowPattern[]>(() =>
    (this.request().suggestions ?? []).flatMap((suggestion) =>
      describePermissionSuggestion(suggestion),
    ),
  );

  private readonly sanitizer = inject(DomSanitizer);

  readonly permDiffHtml = computed<SafeHtml | null>(() => {
    if (this.kind() !== 'generic') return null;
    const name = this.permToolKind();
    if (name !== 'edit' && name !== 'multiedit' && name !== 'fileedit' && name !== 'fileedittool')
      return null;
    const data = asRecord(this.request().input);
    const oldStr = typeof data['old_string'] === 'string' ? data['old_string'] : '';
    const newStr = typeof data['new_string'] === 'string' ? data['new_string'] : '';
    if (!oldStr && !newStr) return null;
    const filePath = typeof data['file_path'] === 'string' ? data['file_path'] : '';
    const html = highlightedDiffHtml(oldStr, newStr, filePath);
    const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
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

  readonly questions = computed<AskUserQuestion[]>(() => {
    if (this.kind() !== 'ask_user_question') return [];
    const input = asRecord(this.request().input);
    return Array.isArray(input['questions']) ? (input['questions'] as AskUserQuestion[]) : [];
  });

  readonly planContent = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['plan'] === 'string' ? input['plan'] : '';
  });

  readonly planPath = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['planFilePath'] === 'string' ? input['planFilePath'] : '';
  });

  private lastRequestId = '';

  constructor() {
    effect(() => {
      const requestId = this.request().requestId;
      if (requestId === this.lastRequestId) return;
      this.lastRequestId = requestId;
      this.denying.set(false);
      this.denyMessage.set('');
    });
  }

  startDeny(): void {
    this.denying.set(true);
    queueMicrotask(() => this.denyTa?.nativeElement?.focus());
  }

  cancelDeny(): void {
    this.denying.set(false);
    this.denyMessage.set('');
  }

  confirmDeny(): void {
    const msg = this.denyMessage().trim();
    this.deny.emit(msg || undefined);
  }

  onDenyKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDeny();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.confirmDeny();
    }
  }

  submitQuestionAnswers(answers: Record<string, string | string[]>): void {
    this.approve.emit({
      remember: false,
      content: { answers },
    });
  }
}

function normalizeToolName(name: string | undefined): string {
  return normalizeToolNameForUi(name ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function strField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function describePermissionSuggestion(suggestion: AgentPermissionUpdate): AlwaysAllowPattern[] {
  switch (suggestion.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return suggestion.rules.map((rule) => ({
        label: formatRuleAction(suggestion.type),
        pattern: formatRulePattern(rule.toolName, rule.ruleContent),
        detail: `${formatPermissionBehavior(suggestion.behavior)} in ${formatPermissionDestination(suggestion.destination)}`,
      }));
    case 'addDirectories':
    case 'removeDirectories':
      return suggestion.directories.map((directory) => ({
        label: suggestion.type === 'addDirectories' ? 'Directory' : 'Remove directory',
        pattern: directory,
        detail: `Applies in ${formatPermissionDestination(suggestion.destination)}`,
      }));
    case 'setMode':
      return [
        {
          label: 'Mode',
          pattern: suggestion.mode,
          detail: `Applies in ${formatPermissionDestination(suggestion.destination)}`,
        },
      ];
  }
}

function formatRulePattern(toolName: string, ruleContent?: string): string {
  const cleanTool = toolName.trim() || 'Tool';
  const cleanRule = ruleContent?.trim();
  return cleanRule ? `${cleanTool}(${cleanRule})` : cleanTool;
}

function formatRuleAction(type: 'addRules' | 'replaceRules' | 'removeRules'): string {
  switch (type) {
    case 'addRules':
      return 'Rule';
    case 'replaceRules':
      return 'Replace';
    case 'removeRules':
      return 'Remove';
  }
}

function formatPermissionBehavior(behavior: string): string {
  const clean = behavior.trim();
  if (!clean) return 'Saved';
  if (clean.toLowerCase() === 'allow') return 'Allow';
  if (clean.toLowerCase() === 'deny') return 'Deny';
  return clean;
}

function formatPermissionDestination(destination: AgentPermissionUpdate['destination']): string {
  switch (destination) {
    case 'userSettings':
      return 'user settings';
    case 'projectSettings':
      return 'project settings';
    case 'localSettings':
      return 'local settings';
    case 'session':
      return 'this session';
    case 'cliArg':
      return 'the current run';
  }
}
