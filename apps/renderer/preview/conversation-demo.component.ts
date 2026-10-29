import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import {
  AgentPickerComponent,
  ApprovalCardComponent,
  ChatComponent,
  ComposerComponent,
  ComposerQueueComponent,
  FileChipComponent,
  MarkdownComponent,
  MentionComponent,
  MentionMenuComponent,
  ModeToggleComponent,
  NowLineComponent,
  OutcomeBarComponent,
  PermissionPickerComponent,
  PlanCardComponent,
  PresetCardComponent,
  PresetPickerComponent,
  QuestionCardComponent,
  SessionStartComponent,
  SideThreadComponent,
  ThinkingBlockComponent,
  ToolStepComponent,
  ToolsMenuComponent,
  TurnComponent,
  TurnNavComponent,
  WorkTimelineComponent,
  StreamTextComponent,
  MessageComponent,
  type AgentConfig,
  type AgentHarness,
  type ApprovalStatus,
  type ChatExchange,
  type ComposerSubmission,
  type ConversationMention,
  type ConversationMode,
  type McpServer,
  type QuestionAnswers,
  type WorkStep,
} from "../src/app/conversation";
@Component({
  selector: "ex-conversation-demo",
  imports: [
    AgentPickerComponent,
    ApprovalCardComponent,
    ChatComponent,
    ComposerComponent,
    ComposerQueueComponent,
    FileChipComponent,
    MarkdownComponent,
    MentionComponent,
    MentionMenuComponent,
    ModeToggleComponent,
    NowLineComponent,
    OutcomeBarComponent,
    PermissionPickerComponent,
    PlanCardComponent,
    PresetCardComponent,
    PresetPickerComponent,
    QuestionCardComponent,
    SessionStartComponent,
    SideThreadComponent,
    ThinkingBlockComponent,
    ToolStepComponent,
    ToolsMenuComponent,
    TurnComponent,
    TurnNavComponent,
    WorkTimelineComponent,
    StreamTextComponent,
    MessageComponent,
  ],
  templateUrl: "./conversation-demo.component.html",
  styleUrl: "./conversation-demo.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationDemoComponent {
  readonly mode = signal<ConversationMode>("code");
  readonly permission = signal<string>("edits");
  readonly agent = signal<AgentConfig>({
    preset: "Thorough",
    mark: "CX",
    harness: "codex",
    model: "GPT-5",
    thinking: "High",
    context: 0.42,
  });
  readonly presets: readonly AgentConfig[] = [
    this.agent(),
    {
      preset: "Quick pass",
      mark: "CX",
      harness: "codex",
      model: "GPT-5",
      thinking: "Low",
      fast: true,
    },
    {
      preset: "Explore",
      mark: "CL",
      harness: "claude",
      model: "Sonnet",
      thinking: "Medium",
    },
  ];
  readonly harnesses: readonly AgentHarness[] = [
    {
      id: "codex",
      label: "Codex",
      mark: "CX",
      models: [
        {
          id: "GPT-5",
          label: "GPT-5",
          thinking: ["Off", "Low", "Medium", "High"],
        },
      ],
    },
  ];
  readonly servers: readonly McpServer[] = [
    { id: "docs", name: "Documentation", tools: 8, on: true },
    { id: "github", name: "GitHub", tools: 12, on: true },
    {
      id: "browser",
      name: "Browser",
      error: "Reconnect to use browser tools",
      on: false,
    },
  ];
  readonly mentions: readonly ConversationMention[] = [
    {
      id: "session-1",
      kind: "session",
      label: "Retry policy",
      status: "done",
      meta: "Elevenex · 12 minutes ago",
    },
    {
      id: "task-42",
      kind: "task",
      label: "Rate-limit refunds",
      meta: "Elevenex · active",
    },
    {
      id: "file-1",
      kind: "file",
      label: "retry.ts",
      meta: "src/payments/retry.ts",
    },
  ];
  readonly files = [
    { path: "src/payments/retry.ts", add: 42, del: 8, status: "M" as const },
    {
      path: "src/payments/retry.spec.ts",
      add: 68,
      del: 2,
      status: "M" as const,
    },
    { path: "docs/refunds.md", add: 12, status: "A" as const },
  ];
  readonly steps: readonly WorkStep[] = [
    {
      id: "say",
      kind: "say",
      text: "I’ll trace the retry path, then check the existing tests before changing the behavior.",
    },
    {
      id: "read-1",
      kind: "read",
      detail: "src/payments/retry.ts",
      status: "done",
    },
    {
      id: "read-2",
      kind: "read",
      detail: "src/payments/refunds.ts",
      status: "done",
    },
    { id: "search", kind: "search", detail: "Retry-After", status: "done" },
    {
      id: "thought",
      kind: "think",
      title: "Respecting the server’s retry window",
      text: "A bounded delay keeps retries useful while ensuring the server has time to recover.",
      duration: 9,
      status: "done",
    },
    {
      id: "edit",
      kind: "edit",
      detail: "src/payments/retry.ts",
      status: "done",
      hunk: [
        "- const delay = 1000;",
        "+ const delay = boundedRetryAfter(response);",
      ],
    },
    {
      id: "test",
      kind: "test",
      detail: "pnpm test payments",
      result: "200/200 passed",
      status: "done",
      duration: 12,
      output: "200 tests passed in 12s",
    },
  ];
  readonly liveStep: WorkStep = {
    id: "live",
    kind: "test",
    detail: "pnpm test payments",
    status: "running",
    meta: "143 / 200",
    elapsed: 4,
    progress: 0.715,
  };
  readonly exchanges = signal<readonly ChatExchange[]>([
    {
      id: "demo-1",
      prompt:
        "Can you make refund retries respect Retry-After without delaying successful requests?",
      time: "10:42",
      author: "Codex",
      mark: "CX",
      status: "done",
      steps: this.steps,
      answer:
        "Refund retries now respect the server’s `Retry-After` header, with a bounded backoff when the header is missing. Successful requests return immediately.\n\n- Added coverage for dates and delay values.\n- Kept the existing cancellation behavior.\n\nAll **200 tests passed**.",
      duration: 252,
      files: this.files,
    },
    {
      id: "demo-2",
      prompt: "What happens when the header is invalid?",
      time: "10:47",
      author: "Codex",
      mark: "CX",
      status: "done",
      steps: [],
      answer:
        "An invalid header falls back to the existing exponential backoff. The delay is clamped to the configured maximum, so malformed values cannot pause the queue indefinitely.",
      duration: 8,
    },
    {
      id: "demo-3",
      prompt: "Add a regression test for a past date too.",
      time: "10:48",
      author: "Codex",
      mark: "CX",
      status: "live",
      steps: [...this.steps.slice(0, 3), this.liveStep],
      answer:
        "The new test covers an expired HTTP date and confirms that the retry proceeds",
      elapsed: 19,
    },
  ]);
  readonly approval = signal<ApprovalStatus>("pending");
  readonly answers = signal<QuestionAnswers | undefined>(undefined);
  readonly selectedPreset = signal("Thorough");
  readonly queue = signal([
    { id: "queued-1", text: "Please document the fallback behavior too." },
  ]);
  readonly lastAction = signal("");
  readonly richMarkdown =
    "# A predictable retry policy\n\nThe **server’s guidance** wins. Invalid values use a *bounded fallback*, and ~~unlimited waits~~ are gone. See [the implementation](src/payments/retry.ts) or [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110).\n\n> [!TIP]\n> Keep cancellation connected to the caller.\n\n1. Read the header.\n2. Clamp the delay.\n   - Preserve abort signals.\n   - Keep successful requests fast.\n\n- [x] Date headers\n- [x] Numeric headers\n- [ ] Production observation\n\n| Input | Behavior |\n| --- | --- |\n| `5` | Wait 5 seconds |\n| Past date | Retry now |\n\n```ts\nconst delay = Math.max(0, Math.min(maxDelay, retryAfter));\nawait sleep(delay, { signal });\n```\n\n---\n\n![A report](report.html)";
  readonly questions = [
    {
      id: "policy",
      header: "Retry policy",
      question: "How should we handle a missing Retry-After header?",
      options: [
        {
          label: "Use bounded backoff",
          detail: "Keep the existing behavior with a maximum delay.",
          recommended: true,
        },
        {
          label: "Retry immediately",
          detail: "Useful only for safe internal requests.",
        },
      ],
    },
    {
      id: "coverage",
      header: "Coverage",
      question: "Which cases should the test cover?",
      kind: "multi" as const,
      options: [
        { label: "Past HTTP date" },
        { label: "Invalid value" },
        { label: "Cancellation" },
      ],
    },
  ];
  submitted(value: ComposerSubmission): void {
    this.lastAction.set(`${value.intent}: ${value.text}`);
    if (value.intent === "queue") {
      this.queue.update((items) => [
        ...items,
        { id: `queued-${items.length + 1}`, text: value.text },
      ]);
    }
  }
}
