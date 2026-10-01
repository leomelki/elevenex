import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import {
  detectHljsLang,
  escapeHtml,
  highlightedPatchHtml,
  highlightedUnifiedDiffHtml,
  splitHighlightedLines,
} from '@/shared/agent-chat/tools/code-highlight';
import { InlineDiffComponent } from '@/shared/agent-chat/tools/inline-diff.component';
import { ToolCommandComponent } from '@/shared/agent-chat/tools/tool-command.component';
import { isToolDenied } from '@/shared/agent-chat/tools/tool-denial';
import { ToolKeyValueComponent } from '@/shared/agent-chat/tools/tool-key-value.component';
import { ToolOutputComponent } from '@/shared/agent-chat/tools/tool-output.component';
import { ToolTodoItem, ToolTodosComponent } from '@/shared/agent-chat/tools/tool-todos.component';
import { ClaudeMessageComponent } from '@/shared/agent-chat/transcript/claude-message.component';
import { ClaudeThinkingComponent } from '@/shared/agent-chat/transcript/claude-thinking.component';
import {
  PairedTranscriptUnit,
  pairTranscript,
} from '@/shared/agent-chat/transcript/paired-transcript';
import {
  contentToString,
  describeAgentTool,
  extractToolError,
  isHardError,
  ResultSummary,
  resultSummary,
  ToolDisplay,
} from '@/shared/agent-tools/agent-tool-format';
import { ZardButtonComponent } from '@/shared/components/button';
import {
  AgentPermissionApproval,
  AgentToolInteractionSummary,
  AgentToolProgress,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';
import { CommonModule } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  forwardRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideActivity,
  lucideAlertTriangle,
  lucideArchive,
  lucideBell,
  lucideBraces,
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCpu,
  lucideDatabase,
  lucideFilePen,
  lucideFilePlus,
  lucideFileText,
  lucideFocus,
  lucideFolderOpen,
  lucideFolderSearch,
  lucideGitBranch,
  lucideGitCompare,
  lucideGitFork,
  lucideGlobe,
  lucideHelpCircle,
  lucideLayoutDashboard,
  lucideLink,
  lucideListTodo,
  lucideLoader,
  lucideLoaderCircle,
  lucideLockKeyhole,
  lucideMap,
  lucideMessageSquare,
  lucideMonitor,
  lucidePencilLine,
  lucidePlugZap,
  lucidePlusCircle,
  lucideRefreshCw,
  lucideRotateCcw,
  lucideScroll,
  lucideSearch,
  lucideSettings,
  lucideShield,
  lucideShieldCheck,
  lucideSparkles,
  lucideStopCircle,
  lucideTerminal,
  lucideTimer,
  lucideTrash2,
  lucideUsers,
} from '@ng-icons/lucide';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { parseFileChanges } from './file-changes';
import { countLineDiff, extractToolEdits } from './turn-change-stats';

type Todo = ToolTodoItem;

@Component({
  selector: 'cw-tool-call',
  standalone: true,
  imports: [
    ZardButtonComponent,
    CommonModule,
    NgIcon,
    AgentMarkdownComponent,
    ClaudeMessageComponent,
    ClaudeThinkingComponent,
    InlineDiffComponent,
    ToolCommandComponent,
    ToolKeyValueComponent,
    ToolOutputComponent,
    ToolTodosComponent,
    forwardRef(() => ClaudeToolCallComponent),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideActivity,
      lucideAlertTriangle,
      lucideArchive,
      lucideBell,
      lucideBraces,
      lucideCheck,
      lucideChevronRight,
      lucideCircleAlert,
      lucideCircleCheck,
      lucideCpu,
      lucideDatabase,
      lucideFilePen,
      lucideFilePlus,
      lucideFileText,
      lucideFocus,
      lucideFolderOpen,
      lucideFolderSearch,
      lucideGitBranch,
      lucideGitCompare,
      lucideGitFork,
      lucideGlobe,
      lucideHelpCircle,
      lucideLayoutDashboard,
      lucideLink,
      lucideListTodo,
      lucideLoader,
      lucideLoaderCircle,
      lucideLockKeyhole,
      lucideMap,
      lucideMessageSquare,
      lucideMonitor,
      lucidePencilLine,
      lucidePlugZap,
      lucidePlusCircle,
      lucideRefreshCw,
      lucideRotateCcw,
      lucideScroll,
      lucideSearch,
      lucideSettings,
      lucideShield,
      lucideShieldCheck,
      lucideSparkles,
      lucideStopCircle,
      lucideTerminal,
      lucideTimer,
      lucideTrash2,
      lucideUsers,
    }),
  ],
  templateUrl: './claude-tool-call.component.html',
  styleUrl: './claude-tool-call.component.scss',
})
export class ClaudeToolCallComponent {
  readonly call = input.required<AgentTranscriptItem>();
  readonly result = input<AgentTranscriptItem | null>(null);
  readonly childItems = input<readonly AgentTranscriptItem[]>([]);
  readonly isLive = input<boolean>(false);
  readonly progress = input<AgentToolProgress | null>(null);
  readonly turnId = input<string | null>(null);
  readonly hasAgentHistory = input<boolean>(false);

  readonly approve = output<AgentPermissionApproval>();
  readonly deny = output<string | undefined>();
  readonly inspect = output<string>();

  private readonly openState = signal<boolean | null>(null);
  private readonly promptOpenState = signal<boolean>(false);
  private readonly streamOpenState = signal<boolean | null>(null);
  private readonly timerTick = signal(Date.now());
  private userHasScrolledUp = false;
  private readonly streamBodyEl = viewChild<ElementRef<HTMLElement>>('streamBody');

  readonly streamOpen = computed(() => this.streamOpenState() ?? this.isLive());

  readonly promptOpen = computed(() => this.promptOpenState());

  constructor() {
    effect(() => {
      const live = this.isLive();
      untracked(() => {
        if (!live) {
          if (this.userHasScrolledUp && this.streamOpenState() === null) {
            this.streamOpenState.set(true);
          }
          this.userHasScrolledUp = false;
        }
      });
    });

    effect((onCleanup) => {
      if (this.display().kind !== 'bash' || this.state() !== 'running') return;
      this.timerTick.set(Date.now());
      const id = window.setInterval(() => this.timerTick.set(Date.now()), 1000);
      onCleanup(() => window.clearInterval(id));
    });

    afterRenderEffect(() => {
      this.childUnits();
      const el = this.streamBodyEl()?.nativeElement;
      if (!el || !untracked(() => this.streamOpen()) || this.userHasScrolledUp) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  toggleStream(): void {
    this.streamOpenState.update((cur) => !(cur ?? this.isLive()));
  }

  onStreamScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.userHasScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 10;
  }

  togglePrompt(): void {
    this.promptOpenState.update((v) => !v);
  }

  readonly agentPromptPreview = computed(() => {
    const text = this.agentPrompt().replace(/\s+/g, ' ').trim();
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  });

  readonly display = computed<ToolDisplay>(() => describeAgentTool(this.call()));

  readonly state = computed<'running' | 'waiting' | 'denied' | 'error' | 'done'>(() => {
    if (isToolDenied(this.call())) return 'denied';
    if (!this.result() && this.isLive()) return 'running';
    if (isHardError(this.result())) return 'error';
    return 'done';
  });

  readonly summary = computed<ResultSummary | null>(() => {
    if (this.state() === 'denied') {
      return { text: this.interaction()?.decisionLabel ?? 'Denied', tone: 'warn' };
    }
    if (this.state() === 'running') {
      if (this.display().kind === 'bash') {
        return {
          text: `Running ${formatElapsedSeconds(this.runningElapsedSeconds())}`,
          tone: 'neutral',
        };
      }
      return null;
    }
    if (this.state() === 'waiting') return null;
    if (this.display().kind === 'file_changes' && !isHardError(this.result())) {
      const diffs = this.fileChanges();
      const additions = diffs.reduce((sum, diff) => sum + diff.additions, 0);
      const deletions = diffs.reduce((sum, diff) => sum + diff.deletions, 0);
      const files = diffs.length;
      return {
        text: `${files} ${files === 1 ? 'file' : 'files'} · +${additions} -${deletions}`,
        tone: this.result()?.isError ? 'warn' : 'ok',
      };
    }
    return resultSummary(this.display().kind, this.result(), this.interaction());
  });

  readonly runningElapsedSeconds = computed(() => {
    const progress = this.progress();
    if (progress && Number.isFinite(progress.elapsedTimeSeconds)) {
      const updatedAt = Date.parse(progress.timestamp);
      const secondsSinceProgress = Number.isFinite(updatedAt)
        ? Math.floor((this.timerTick() - updatedAt) / 1000)
        : 0;
      return Math.max(0, Math.floor(progress.elapsedTimeSeconds) + secondsSinceProgress);
    }

    const startedAt = Date.parse(this.call().receivedAt ?? this.call().timestamp);
    if (!Number.isFinite(startedAt)) return 0;
    return Math.max(0, Math.floor((this.timerTick() - startedAt) / 1000));
  });

  readonly resultText = computed(() => {
    const raw = contentToString(this.result()?.content);
    return isHardError(this.result()) ? extractToolError(raw) : raw;
  });

  readonly resultImages = computed(() =>
    (this.result()?.images ?? []).map((image) => ({
      dataUrl: `data:${image.mediaType};base64,${image.data}`,
    })),
  );

  readonly readImageAlt = computed(() => {
    const input = this.call().toolInput as
      | { file_path?: string; filePath?: string; path?: string }
      | undefined;
    const path = input?.file_path ?? input?.filePath ?? input?.path;
    return path ? `Image read from ${path}` : 'Image read by tool';
  });

  readonly canExpand = computed(() => {
    const k = this.display().kind;
    if (k === 'todo_write' || k === 'worktree') return false;
    // Always expandable if we have a result, or if this is an agent (has prompt)
    if (
      k === 'plan_mode' ||
      k === 'enter_plan_mode' ||
      k === 'exit_plan_mode' ||
      k === 'ask_user_question'
    ) {
      return !!this.result() || !!this.interaction();
    }
    return (
      !!this.result() ||
      !!this.interaction() ||
      !!this.agentPrompt() ||
      this.isEditDiff() ||
      this.fileChanges().length > 0 ||
      !!this.bashCommand() ||
      this.childUnits().length > 0
    );
  });

  readonly open = computed(() => {
    const explicit = this.openState();
    if (explicit !== null) return explicit;
    return this.state() === 'error';
  });

  readonly todos = computed<Todo[]>(() => {
    if (this.display().kind !== 'todo_write') return [];
    const input = this.call().toolInput as { todos?: Todo[] } | undefined;
    return Array.isArray(input?.todos) ? (input!.todos as Todo[]) : [];
  });

  readonly bashCommand = computed(() => {
    if (this.display().kind !== 'bash') return '';
    const input = this.call().toolInput as { command?: string } | undefined;
    return input?.command ?? '';
  });

  // Bash shows a human-readable description as the target text; hovering reveals the
  // literal command so it stays verifiable without expanding the tool call.
  readonly targetTitle = computed(() => {
    const cmd = this.bashCommand();
    return cmd || this.display().target;
  });

  readonly editFilePath = computed(() => {
    if (this.display().kind !== 'edit') return '';
    const data = this.call().toolInput as
      | { file_path?: string; filePath?: string; path?: string }
      | undefined;
    return data?.file_path ?? data?.filePath ?? data?.path ?? '';
  });

  readonly editOperations = computed(() =>
    this.display().kind === 'edit' ? extractToolEdits(this.call()) : [],
  );
  readonly isEditDiff = computed(() => this.editOperations().some((file) => file.edits.length > 0));
  readonly editDiffs = computed(() =>
    this.editOperations().flatMap((file) =>
      file.edits.map((edit) => {
        const raw = edit.patch
          ? highlightedPatchHtml(edit.patch, file.filePath)
          : highlightedUnifiedDiffHtml(
              edit.oldString,
              edit.newString,
              file.filePath,
              edit.startLine ?? 1,
            );
        const stats = countLineDiff(edit.oldString, edit.newString);
        return {
          html: this.sanitizer.bypassSecurityTrustHtml(
            DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } }),
          ),
          label: edit.label ? file.filePath + ' · ' + edit.label : file.filePath,
          additions: edit.additions ?? stats.additions,
          deletions: edit.deletions ?? stats.deletions,
        };
      }),
    ),
  );

  readonly fileChanges = computed(() =>
    this.display().kind === 'file_changes' ? parseFileChanges(this.call().toolInput) : [],
  );

  readonly fileChangeDiffs = computed<
    Array<{
      path: string;
      html: SafeHtml | string;
      label: string;
      additions: number;
      deletions: number;
      emptyText: string;
    }>
  >(() => {
    if (this.display().kind !== 'file_changes') return [];
    return this.fileChanges().map((change) => {
      const { path, patch } = change;
      const raw = patch
        ? highlightedPatchHtml(patch, path)
        : highlightedUnifiedDiffHtml(change.oldString, change.newString, path);
      const html = raw
        ? this.sanitizer.bypassSecurityTrustHtml(
            DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } }),
          )
        : '';
      return { ...change, html };
    });
  });

  readonly writeContent = computed(() => {
    if (this.display().kind !== 'write') return '';
    const data = this.call().toolInput as { content?: string } | undefined;
    return data?.content ?? '';
  });

  readonly writeFilePath = computed(() => {
    if (this.display().kind !== 'write') return '';
    const data = this.call().toolInput as { file_path?: string } | undefined;
    return data?.file_path ?? '';
  });

  private readonly writeExpandedState = signal(false);
  readonly writeExpanded = computed(() => this.writeExpandedState());

  readonly writeLineCount = computed(() => {
    const c = this.writeContent();
    if (!c) return 0;
    const parts = c.split('\n');
    return c.endsWith('\n') ? parts.length - 1 : parts.length;
  });

  readonly writeHiddenLines = computed(() => {
    const total = this.writeLineCount();
    return total > WRITE_PREVIEW_LINES ? total - WRITE_PREVIEW_LINES : 0;
  });

  private readonly sanitizer = inject(DomSanitizer);

  readonly writeContentHtml = computed<SafeHtml>(() => {
    const content = this.writeContent();
    if (!content) return '';
    const expanded = this.writeExpanded();
    const visible = expanded
      ? content
      : content.split('\n').slice(0, WRITE_PREVIEW_LINES).join('\n');
    const lang = detectHljsLang(this.writeFilePath());
    let highlighted: string;
    try {
      highlighted = lang
        ? hljs.highlight(visible, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(visible).value;
    } catch {
      highlighted = escapeHtml(visible);
    }
    const lines = splitHighlightedLines(highlighted);
    const wrapped = lines
      .map(
        (line) =>
          `<span class="cw-write__line"><span class="cw-write__sign">+</span><span class="cw-write__code">${line.length ? line : ' '}</span></span>`,
      )
      .join('\n');
    const safe = DOMPurify.sanitize(wrapped, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
  });

  toggleWriteExpand(): void {
    this.writeExpandedState.update((v) => !v);
  }

  readonly agentPrompt = computed(() => {
    if (this.display().kind !== 'task_agent') return '';
    const parsedPrompt = this.parsedResult()?.['prompt'];
    if (typeof parsedPrompt === 'string' && parsedPrompt.trim()) return parsedPrompt;
    const data = this.call().toolInput as { prompt?: string; description?: string } | undefined;
    return data?.prompt ?? data?.description ?? '';
  });

  readonly parsedResult = computed<Record<string, unknown> | null>(() => {
    const text = this.resultText().trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      // Arrays (legacy serialized tool_result content) are handled in
      // agentResponse via a separate parse — skip here so keyed consumers
      // (agentPrompt, askAnswers, planMarkdown, etc.) stay simple.
      if (Array.isArray(parsed)) return null;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });

  readonly interaction = computed<AgentToolInteractionSummary | null>(
    () => this.call().interaction ?? null,
  );

  readonly interactionAnswers = computed<Array<{ question: string; answer: string }>>(() => {
    const answers = this.interaction()?.answers ?? [];
    return answers.map((entry) => ({ question: entry.question, answer: entry.answer }));
  });

  readonly interactionContentText = computed(() => {
    const interaction = this.interaction();
    if (!interaction?.content) return '';
    const { answers: _answers, ...rest } = interaction.content;
    if (!Object.keys(rest).length) return '';
    return JSON.stringify(rest, null, 2);
  });

  readonly askAnswers = computed<Array<{ question: string; answer: string }>>(() => {
    if (this.interactionAnswers().length) return this.interactionAnswers();
    if (this.display().kind !== 'ask_user_question') return [];
    const answers = this.parsedResult()?.['answers'];
    if (!answers || typeof answers !== 'object') return [];
    return Object.entries(answers as Record<string, unknown>).map(([question, answer]) => ({
      question: this.askQuestionLabel(question),
      answer: this.askAnswerText(answer),
    }));
  });

  readonly isQuestionResponse = computed(
    () => this.display().kind === 'ask_user_question' && (!!this.result() || !!this.interaction()),
  );

  readonly questionResponseSent = computed(() => this.askAnswers().length > 0);

  readonly questionReceiptEntries = computed<Array<{ question: string; answer: string }>>(() => {
    const answers = this.askAnswers();
    if (answers.length) return answers;
    const input = this.call().toolInput as { questions?: unknown[] } | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    return questions
      .map((candidate) => {
        if (!candidate || typeof candidate !== 'object') return null;
        const question = (candidate as Record<string, unknown>)['question'];
        return typeof question === 'string' ? { question, answer: 'No answer was sent.' } : null;
      })
      .filter((entry): entry is { question: string; answer: string } => entry !== null);
  });

  private askQuestionLabel(key: string): string {
    const input = this.call().toolInput as { questions?: unknown[] } | undefined;
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const match = questions.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const question = candidate as Record<string, unknown>;
      return question['id'] === key || question['question'] === key;
    }) as Record<string, unknown> | undefined;
    return typeof match?.['question'] === 'string' ? match['question'] : key;
  }

  private askAnswerText(value: unknown): string {
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['answers'];
      if (Array.isArray(nested)) return nested.map(String).join(', ');
      if (typeof nested === 'string') return nested;
    }
    return String(value ?? '');
  }

  readonly planMarkdown = computed(() => {
    if (this.display().kind !== 'exit_plan_mode') return '';
    const plan = this.parsedResult()?.['plan'];
    if (typeof plan === 'string' && plan) return plan;
    const input = this.call().toolInput as Record<string, unknown> | undefined;
    return typeof input?.['plan'] === 'string' ? input['plan'] : '';
  });

  readonly planFilePath = computed(() => {
    if (this.display().kind !== 'exit_plan_mode') return '';
    const filePath = this.parsedResult()?.['filePath'];
    if (typeof filePath === 'string' && filePath) return filePath;
    const input = this.call().toolInput as Record<string, unknown> | undefined;
    return typeof input?.['planFilePath'] === 'string' ? input['planFilePath'] : '';
  });

  readonly fallbackEntries = computed<Array<{ k: string; v: string }>>(() => {
    const input = this.call().toolInput;
    if (!input || typeof input !== 'object') return [];
    return Object.entries(input as Record<string, unknown>).map(([k, v]) => ({
      k,
      v: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }));
  });

  readonly agentResponse = computed(() => {
    if (this.display().kind !== 'task_agent') return this.resultText();

    const raw = this.resultText().trim();

    // Legacy/resumed sessions have the whole tool_result content serialized
    // as a JSON string (`[{"type":"text","text":"..."}]`). Detect and unwrap.
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const text = extractTextBlocks(parsed);
          if (text) return stripAgentTrailer(text);
        }
      } catch {
        // fall through to other handling
      }
    }

    const parsed = this.parsedResult();
    if (parsed) {
      const content = parsed['content'];
      if (Array.isArray(content)) {
        const text = extractTextBlocks(content);
        if (text) return stripAgentTrailer(text);
      }
      const result = parsed['result'];
      if (typeof result === 'string' && result.trim()) return stripAgentTrailer(result);
    }

    return stripAgentTrailer(raw);
  });

  readonly agentUsageSummary = computed(() => {
    if (this.display().kind !== 'task_agent') return '';
    const parsed = this.parsedResult();
    if (!parsed) return '';

    const parts: string[] = [];
    const toolUses = parsed['totalToolUseCount'];
    const durationMs = parsed['totalDurationMs'];
    const tokens = parsed['totalTokens'];

    if (typeof toolUses === 'number' && toolUses > 0) {
      parts.push(`${toolUses} tool call${toolUses === 1 ? '' : 's'}`);
    }
    if (typeof durationMs === 'number' && durationMs > 0) {
      parts.push(formatDuration(durationMs));
    }
    if (typeof tokens === 'number' && tokens > 0) {
      parts.push(`${tokens.toLocaleString()} tokens`);
    }

    return parts.join(' · ');
  });

  readonly childUnits = computed<PairedTranscriptUnit[]>(() => pairTranscript(this.childItems()));
  readonly childItemsByParentToolUseId = computed(() => {
    const grouped: Record<string, AgentTranscriptItem[]> = {};
    for (const item of this.childItems()) {
      if (!item.parentToolUseId) continue;
      grouped[item.parentToolUseId] = [...(grouped[item.parentToolUseId] ?? []), item];
    }
    return grouped;
  });

  childToolLabel(item: AgentTranscriptItem): string {
    const display = describeAgentTool(item);
    return display.target ? `${display.verb} ${display.target}` : display.verb;
  }

  nestedChildItems(toolUseId: string): AgentTranscriptItem[] {
    return this.childItemsByParentToolUseId()[toolUseId] ?? [];
  }

  isNestedLiveToolUse(toolUseId: string): boolean {
    return this.childItems().some(
      (item) => item.kind === 'tool_use' && item.toolUseId === toolUseId,
    );
  }

  onDeepDiveClick(): void {
    const id = this.turnId();
    if (id) this.inspect.emit(id);
  }

  toggle(): void {
    if (!this.canExpand()) return;
    this.openState.set(!this.open());
  }
}

const WRITE_PREVIEW_LINES = 12;

function extractTextBlocks(blocks: unknown[]): string {
  return blocks
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        return record['text'];
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// The Task tool appends a trailer to every completed-agent tool_result:
//   "agentId: ...\n<usage>total_tokens: ...\ntool_uses: ...\nduration_ms: ...</usage>"
// (see claude-code/src/tools/AgentTool/AgentTool.tsx, mapToolResultToToolResultBlockParam).
// That block is a machine-readable metadata footer — we surface it separately
// via `agentUsageSummary`, so strip it from the human-facing response.
function stripAgentTrailer(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/<usage>[\s\S]*?<\/usage>\s*$/i, '').trimEnd();
  cleaned = cleaned
    .replace(/\n*agentId:[^\n]*(?:\n(?:worktreePath|worktreeBranch):[^\n]*)*\s*$/i, '')
    .trimEnd();
  return cleaned;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${totalSeconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
