import { sessionActivityWork } from './session-activity-fixture';
import { previewChatImage } from './session-chat-media-fixture';
import type { DestroyRef } from "@angular/core";
import { sessionCodexFileItems, sessionShellItems, sessionToolItems } from './session-tools-fixture';
import { sessionTimelineItems, type TimelineScene } from './session-timeline-fixture';
import { SESSION_CHAT_TURN_WORK_LIMIT } from '@elevenex/shared';
import type {
  BackendResult,
  SessionChatAgentRead,
  SessionChatAgentPage,
  SessionChatChangesRead,
  SessionChatChangesPage,
  SessionChatCommand,
  SessionChatContent,
  SessionChatContentRead,
  SessionChatPromptEdit,
  SessionChatPromptEditRead,
  SessionChatItem,
  SessionChatPage,
  SessionChatRead,
  SessionChatRecord,
  SessionChatTurnTimelineRow,
  SessionChatTurnWorkRead,
  SessionChatTurnWorkReply,
  SessionChatToolDetailsReply,
  SessionChatToolDetailsRead,
  SessionChatToolEvidence,
  SessionChatState,
  SessionChatPreset,
  SessionChatCommandReply,
  SessionChatCatalog,
  SessionChatCatalogRead,
  SessionChatPresetDefault,
  SessionChatWorkEvent,
} from "@elevenex/shared";

const savedPresets: readonly SessionChatPreset[] = [
  { id: 'deep', name: 'Deep work', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6', modelLabel: 'GPT-6', reasoning: 'high', fast: false },
  { id: 'quick', name: 'Quick pass', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6', modelLabel: 'GPT-6', reasoning: 'low', fast: true },
  { id: 'explore', name: 'Explore', provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet', modelLabel: 'Claude Sonnet', reasoning: 'medium', fast: false },
];
const stamp = "2026-10-28T10:20:00.000Z";
export const previewChatState = (): SessionChatState => ({
  unseenCompletionAt: null,
  attachments: true,
  sessionMentions: true,
  presets: savedPresets,
  presetCatalogs: true,
  provider: "codex",
  providers: [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "pi", label: "Pi" },
    { id: "opencode", label: "OpenCode" },
  ],
  providerLocked: false,
  controls: { plan: true, reasoning: true, fast: true },
  fast: false,
  phase: "idle",
  canInterrupt: false,
  error: null,
  model: "gpt-6",
  models: [
    {
      id: "gpt-6",
      label: "GPT-6",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      supportsFastMode: true,
    },
    {
      id: "claude",
      label: "Claude",
      reasoningEfforts: ["low", "medium", "high"],
      supportsFastMode: false,
    },
  ],
  reasoning: "high",
  plan: false,
  permissionMode: "default",
  permissionModes: ["default", "acceptEdits"],
  context: { tokens: 28000, limit: 128000, percentage: 22 },
  queue: [],
  queuePaused: false,
  permission: null,
  question: null,
  activity: [],
});
/** A pending question the conversation can answer; pairs with waiting delegated work. */
const retryQuestion: NonNullable<SessionChatState["question"]> = {
  id: "question",
  message: "One behavior needs your decision.",
  url: null,
  questions: [
    {
      id: "retry",
      question: "How long should a retry claim remain valid?",
      multiple: false,
      options: [
        {
          label: "24 hours",
          detail: "Matches the provider’s retention window.",
        },
        {
          label: "7 days",
          detail: "Keeps duplicate protection for a week.",
        },
      ],
    },
  ],
};
/** Background work plus the events the backend keeps: finished work, failures, compaction. */
export const previewChatWork = (now = Date.now()): NonNullable<SessionChatState["work"]> => sessionActivityWork('codex', now);

// Seeded history shares one stamp; runtime receipts use the current time so
// live turns count from a realistic start, as backend receipts do.
const item = (
  id: string,
  kind: SessionChatItem["kind"],
  text: string,
  extra: Partial<SessionChatItem> = {},
): SessionChatItem => ({
  id,
  kind,
  text,
  timestamp: stamp,
  toolId: null,
  toolName: null,
  toolKind: null,
  input: "",
  error: false,
  truncated: false,
  ...extra,
});
const opening = () => [
  item(
    "prompt",
    "user",
    "Find the race condition in payment retries and make concurrent requests safe. Explain the change and verify it.",
  ),
  item(
    "thought",
    "thinking",
    "I’ll trace how retry keys are created, then reproduce the overlap with two concurrent requests.",
  ),
  item("read", "tool_use", "", {
    toolId: "read",
    toolName: "Read",
    toolKind: "read",
    input: '{"file_path":"src/payments/retry.ts"}',
  }),
  item(
    "read-result",
    "tool_result",
    "The idempotency key is generated after the request starts.",
    { toolId: "read" },
  ),
  item(
    "commentary",
    "assistant",
    "Two requests can pass the lookup before either stores the key. I’m adding a single atomic claim before the provider call.",
  ),
  item("test", "tool_use", "", {
    toolId: "test",
    toolName: "Run command",
    toolKind: "bash",
    input: '{"command":"pnpm test retry --runInBand"}',
  }),
  item(
    "test-result",
    "tool_result",
    "PASS src/payments/retry.spec.ts\n12 tests passed, including concurrent requests and delayed provider responses.",
    { toolId: "test" },
  ),
  item(
    "answer",
    "assistant",
    "The retry path now claims the idempotency key **before** calling the payment provider. Concurrent requests share the original result.\n\n- Preserved retry behavior after transient errors.\n- Added coverage for simultaneous and delayed requests.\n- All **12 tests pass**.\n\n```ts\nconst claim = await retries.claim(key);\nif (!claim.created) return claim.result;\n```",
    // A later receipt lets the settled turn show a realistic "Worked for" time.
    { timestamp: "2026-10-28T10:22:14.000Z" },
  ),
];
/** Harness-shaped fixtures stay outside the production import graph. */
export class SessionChatFixture {
  promptEditingScene(running = false, id = 101): void {
    const session = this.session(id);
    session.items = [
      item('edit-context', 'user', 'Review how the retry handler claims requests.', { editable: true }),
      item('edit-context-reply', 'assistant', 'The claim is persisted before the first retry.'),
      item('edit-target', 'user', 'Add coverage for two concurrent retry requests.', {
        editable: true, mentions: [{ sessionId: 102, title: 'Review the race condition' }],
      }),
      item('edit-target-reply', 'assistant', 'The regression now covers two requests arriving at once.'),
      item('edit-later', 'user', 'Document the retry window.', { editable: true }),
      item('edit-later-reply', 'assistant', 'I documented the current retry window.'),
    ];
    session.state = { ...previewChatState(), providerLocked: true, phase: running ? 'running' : 'idle', canInterrupt: running };
    this.changed();
    this.resetVersion = this.version;
  }

  async promptEdit(input: SessionChatPromptEditRead): Promise<BackendResult<SessionChatPromptEdit>> {
    const { taskId, sessionId, itemId } = input, { items } = this.session(sessionId);
    const index = items.findIndex(item => item.id === itemId && item.editable);
    const item = items[index];
    if (!item) return { ok: false, error: { code: 'http', status: 409, message: 'This message is no longer available to edit.' } };
    return { ok: true, value: { taskId, sessionId, itemId, text: item.text,
      revision: this.version.toString(16).padStart(64, '0'),
      laterPrompts: items.slice(index + 1).filter(item => item.kind === 'user').length,
      keepsContext: !!(item.media?.length || item.mentions?.length) } };
  }

  timeline(scene: TimelineScene, id = 101): void {
    const session = this.session(id);
    session.items = [...sessionTimelineItems(scene)];
    session.state = { ...previewChatState(), providerLocked: true,
      phase: scene === 'finished' ? 'idle' : 'running', canInterrupt: scene !== 'finished' };
    this.changed();
    this.resetVersion = this.version;
  }
  appendShellOutput(text: string, id = 101): void {
    const session = this.session(id);
    session.items = session.items.map(item => {
      if (item.id !== "shell-3-result") return item;
      const data = JSON.parse(item.text) as { stdout: string };
      return { ...item, text: JSON.stringify({ ...data, stdout: data.stdout + text }) };
    });
    this.changed();
  }
  private presets = [...savedPresets];
  private defaultProvider = 'codex';
  private defaultIds: readonly string[] = ['deep'];
  private defaultVersion = 1;
  private presetEditing = false;
  /** Exercise first-use layout without replacing the connected chat components. */
  presetCatalog(mode: 'empty' | 'saved' | 'editing' | 'full'): void {
    this.presetEditing = mode === 'editing' || mode === 'full';
    this.presets = mode === 'empty' ? [] : [...savedPresets];
    if (this.presetEditing) {
      const count = mode === 'full' ? 24 : 8;
      this.presets.push(...Array.from({ length: count - savedPresets.length }, (_, index) => ({
        ...savedPresets[index % savedPresets.length]!,
        id: `review-${index + 1}`,
        name: `Review ${index + 1}`,
      })));
    }
    this.defaultProvider = 'codex';
    this.defaultIds = this.presets.length ? ['deep'] : [];
    this.defaultVersion++;
    this.changed();
  }
  private defaultSnapshot(): SessionChatPresetDefault {
    return { id: this.presets.find(p => p.provider === this.defaultProvider && this.defaultIds.includes(p.id))?.id ?? null,
      provider: this.defaultProvider, defaultIds: [...this.defaultIds], revision: this.defaultVersion.toString(16).padStart(64, '0') };
  }
  private catalogDelay = 0;
  private catalogFailure = false;
  catalogBehavior(delay: number, fail = false): void { this.catalogDelay = Math.min(5000, Math.max(0, delay)); this.catalogFailure = fail; }
  /** Cold conversation state must not prevent independent catalog discovery. */
  coldModels(id = 102, model: string | null = null): void {
    const session = this.session(id);
    session.state = { ...session.state, model, models: [] };
    this.changed();
  }
  private catalogData(provider: string): SessionChatCatalog {
    const label = previewChatState().providers?.find(p => p.id === provider)?.label ?? provider;
    const model = provider === 'claude' ? { id: 'sonnet', label: 'Claude Sonnet', reasoningEfforts: ['low', 'medium', 'high'], supportsFastMode: false }
      : provider === 'codex' ? previewChatState().models[0]!
      : { id: provider + '-model', label: 'Provider model', reasoningEfforts: [], supportsFastMode: false };
    return { provider, label, models: [model], model: model.id, reasoning: model.reasoningEfforts?.includes('high') ? 'high' : null,
      fast: false, reasoningAvailable: !!model.reasoningEfforts?.length, fastAvailable: !!model.supportsFastMode, error: null };
  }
  async catalog(input: SessionChatCatalogRead): Promise<BackendResult<SessionChatCatalog>> {
    if (this.catalogDelay) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.timers.delete(timer); this.waiting.delete(input.requestId); resolve(); };
      const timer = setTimeout(done, this.catalogDelay); this.timers.add(timer); this.waiting.set(input.requestId, done);
    });
    return this.catalogFailure ? { ok: false, error: { code: 'http', status: 503, message: 'Could not load this harness’s models. Try again.' } }
      : { ok: true, value: this.catalogData(input.provider) };
  }
  private version = 1;
  private resetVersion = 1;
  private readonly sessions = new Map<
    number,
    { items: SessionChatItem[]; state: SessionChatState }
  >();
  private readonly waiting = new Map<string, () => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private imageState: 'ready' | 'held' | 'failed' = 'ready';
  imageDelivery(state: 'ready' | 'held' | 'failed'): void {
    this.imageState = state;
    if (state !== 'held') for (const done of [...this.waiting.values()]) done();
  }
  private commandFailure = false;
  private delayedReceipts: boolean | 'completion' = false;
  deferUserReceipts(value: boolean | 'completion'): void {
    this.delayedReceipts = value;
  }
  dispatchQueuedPrompt(sessionId = 101, queueId?: string): void {
    const session = this.session(sessionId);
    const next = queueId ? session.state.queue.find(item => item.id === queueId) : session.state.queue[0];
    if (!next) return;
    const timestamp = new Date().toISOString();
    session.state = {
      ...session.state, phase: 'running', canInterrupt: true, queuePaused: false,
      queue: session.state.queue.filter(item => item.id !== next.id),
      dispatchingPrompts: [...(session.state.dispatchingPrompts ?? []), { ...next, timestamp }],
    };
    this.changed();
  }
  finishQueuedPrompt(sessionId = 101): void {
    const session = this.session(sessionId);
    const [next, ...rest] = session.state.dispatchingPrompts ?? [];
    if (!next) return;
    const userId = `sent-${this.version}`;
    session.items.push(
      item(userId, 'user', next.text, { timestamp: next.timestamp }),
      item(`reply-${this.version}`, 'assistant', 'Applying the queued guidance.', { timestamp: next.timestamp }),
    );
    session.state = { ...session.state, activePromptId: userId, dispatchingPrompts: rest };
    this.changed();
  }
  /** Incoming reply growth without a local submission or transcript reset. */
  appendAssistant(text: string, id = 101): void {
    this.session(id).items.push(item(`incoming-${this.version}`, 'assistant', text, { timestamp: new Date().toISOString() }));
    this.changed();
  }
  constructor(destroy: DestroyRef) {
    destroy.onDestroy(() => {
      this.holdReads(false);
      for (const done of this.waiting.values()) done();
      for (const timer of this.timers) clearTimeout(timer);
    });
  }
  private session(id: number) {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        items: id === 101 ? opening() : [],
        state: previewChatState(),
      };
      const defaultPreset = this.presets.find(p => p.id === this.defaultSnapshot().id);
      if (!session.items.length && defaultPreset) {
        session.state = { ...session.state, provider: defaultPreset.provider, model: defaultPreset.model, reasoning: defaultPreset.reasoning, fast: defaultPreset.fast,
          ...(defaultPreset.provider === 'claude' ? { models: [{ id: 'sonnet', label: 'Claude Sonnet', reasoningEfforts: ['low', 'medium', 'high'] }] } : {}) };
      }
      session.state = {
        ...session.state,
        providerLocked: session.items.length > 0,
      };
      this.sessions.set(id, session);
    }
    return session;
  }
  /** Durable completion marker and final content through the real read path. */
  unseenCompletionAt(id: number): string | null {
    return this.session(id).state.unseenCompletionAt ?? null;
  }
  completeUnseen(id: number, at: string): void {
    const session = this.session(id);
    session.items = [...session.items, item(`finished-${at}`, 'assistant', 'The agent has finished working. This reply has not been viewed yet.')];
    session.state = { ...session.state, unseenCompletionAt: at, phase: 'idle', canInterrupt: false, permission: null, question: null, work: undefined };
    this.changed(); this.resetVersion = this.version;
  }
  scenario(
    mode:
      | "images"
      | "permission"
      | "question"
      | "running"
      | "failed"
      | "history"
      | "panel-reflow"
      | "ready"
      | "new"
      | "unknown"
      | "long"
      | "long-message"
      | "tools"
      | "tools-running"
      | "tools-incomplete"
      | "tools-codex-files"
      | "shell-results"
      | "reply-only"
      | "reply-only-running"
      | "reply-boundaries",
    id = 101,
  ): void {
    const session = this.session(id);
    session.items = opening();
    session.state = previewChatState();
    if (mode === 'new') { session.items = []; session.state = { ...session.state, providerLocked: false }; }
    if (mode === 'images') session.items = [
      item('image-prompt', 'user', 'Draw a friendly robot and show the saved image.'),
      item('image-output', 'tool_result', 'Image attachment', { media: [{ id: '0', path: 'generated-robot', caption: 'Generated robot', inline: true }] }),
      item('image-answer', 'assistant', "Here’s a friendly robot waving hello!\n\n![Saved image](/Users/agent/.codex/generated_images/robot.png)", {
        media: [{ id: '0', path: '/Users/agent/.codex/generated_images/robot.png', caption: 'Saved image', inline: false }],
      }),
    ];
    if (mode === 'tools-codex-files') session.items = sessionCodexFileItems();
    if (mode === 'shell-results') session.items = sessionShellItems();
    if (mode === "reply-only" || mode === "reply-only-running") {
      session.items = [
        item("reply-prompt", "user", "hi"),
        item("reply-answer", "assistant", "Hi. How can I help?"),
      ];
      session.state = {
        ...session.state,
        phase: mode === "reply-only-running" ? "running" : "idle",
        canInterrupt: mode === "reply-only-running",
      };
    }
    if (mode === 'tools' || mode === 'tools-running' || mode === 'tools-incomplete') {
      session.items = sessionToolItems(mode !== 'tools').map(item =>
        mode === 'tools-incomplete' && item.id === 'tools-answer'
          ? { ...item, text: 'No completion receipt was reported for the final command.' } : item);
      if (mode === 'tools-running')
        session.state = { ...session.state, phase: 'running', canInterrupt: true };
    }
    if (mode === "reply-boundaries")
      session.items = [
        item("u1", "user", "hi"),
        item("a1", "assistant", "Hi. How can I help?"),
        item("s1", "system", "Turn completed"),
        item("u2", "user", "write a file to test the agent"),
        item(
          "a2",
          "assistant",
          "Created the test file and verified its contents.",
        ),
        item("r2", "tool_result", "File write completed", {
          toolId: "late-result",
        }),
      ];
    if (mode === "permission")
      session.state = {
        ...session.state,
        phase: "waiting",
        canInterrupt: true,
        permission: {
          id: "approval",
          title: "Run command",
          description: "The agent wants to run the focused regression suite.",
          input: "pnpm test retry --runInBand",
          allowAlways: false,
        },
      };
    if (mode === "question")
      session.state = {
        ...session.state,
        phase: "waiting",
        question: retryQuestion,
      };
    if (mode === "running") {
      session.items = session.items.slice(0, 6);
      session.state = {
        ...session.state,
        phase: "running",
        canInterrupt: true,
        work: previewChatWork(),
      };
    }
    if (mode === "failed")
      session.state = {
        ...session.state,
        phase: "error",
        error: "The provider disconnected. Your conversation is saved.",
      };
    if (mode === "history")
      session.items = Array.from({ length: 4000 }, (_, i) =>
        item(
          `history-${i}`,
          i % 2 ? "assistant" : "user",
          i % 2
            ? `Verified request ${Math.floor(i / 2)}.`
            : `Check request ${Math.floor(i / 2)}.`,
        ),
      );
    if (mode === 'panel-reflow')
      session.items = Array.from({ length: 30 }, (_, i) => [
        item(`panel-prompt-${i}`, 'user', `Review section ${i}`),
        item(`panel-reply-${i}`, 'assistant', ('A detailed response with enough prose to wrap when the side panel opens. '.repeat(30) + '\n\n').repeat(5)),
      ]).flat();
    if (mode === "long")
      session.items[6] = {
        ...session.items[6]!,
        text: Array.from(
          { length: 1600 },
          (_, i) => "Verified concurrent request " + i + ": passed",
        ).join("\n"),
        truncated: true,
      };
    if (mode === "long-message")
      session.items[7] = {
        ...session.items[7]!,
        text: Array.from({ length: 1600 }, (_, i) => "Verified concurrent request " + i + ": passed").join("\n"),
        truncated: true,
      };
    if (mode === "unknown") this.commandFailure = true;
    session.state = {
      ...session.state,
      providerLocked: session.items.length > 0,
    };
    this.changed();
    this.resetVersion = this.version;
  }
  private changeMode: 'created' | 'many' | 'empty' | 'failed' | 'evidence' = 'created';
  changedFiles(mode: 'created' | 'many' | 'empty' | 'failed' | 'evidence', id = 101): void {
    this.changeMode = mode;
    const files = this.changeRows();
    const session = this.session(id);
    session.state = { ...previewChatState(), providerLocked: true };
    session.items = [
      item('change-prompt', 'user', 'Create a small file to test the agent.'),
      item('change-answer', 'assistant', mode === 'empty' || mode === 'evidence' ? 'No net changes.' : 'Created `skill-test.txt` with a short test message.'),
      item('change-capture', 'system', '', { changes: { total: files.length, files: files.slice(0, 200),
        ...(mode === 'evidence' ? { sources: ['provider', 'command'] } : {}) } }),
    ];
    this.changed(); this.resetVersion = this.version;
  }
  private changeRows(source?: SessionChatChangesRead['source']) {
    if (this.changeMode === 'evidence') return source && source !== 'net'
      ? [{ path: 'example.ts', status: 'M' as const, add: 1, del: 0 }] : [];
    return Array.from({ length: this.changeMode === 'empty' ? 0 : this.changeMode === 'many' ? 1001 : 1 }, (_, i) => ({ path: i ? `src/example-${i}.ts` : 'skill-test.txt', status: 'A' as const, add: i ? 401 : 1, del: 0 }));
  }
  async changes(input: SessionChatChangesRead): Promise<BackendResult<SessionChatChangesPage>> {
    if (this.changeMode === 'failed') return { ok: false, error: { code: 'transport', message: 'Could not load the reply changes.' } };
    const files = this.changeRows(input.source), index = input.path ? files.findIndex(file => file.path === input.path) : -1;
    const offset = index >= 0 ? Math.floor(index / 100) * 100 : input.offset;
    const lineOffset = input.lineOffset ?? 0;
    const totalLines = index > 0 ? 401 : 1;
    const count = Math.min(400, Math.max(0, totalLines - lineOffset));
    const evidence = this.changeMode === 'evidence';
    return { ok: true, value: { turnId: input.turnId, revision: (input.source === 'provider' ? 'b' : input.source === 'command' ? 'c' : 'a').repeat(64), offset,
      ...(evidence ? { sources: ['provider', 'command'], source: input.source,
        ...(input.source === 'command' ? { notice: 'These edits were observed during command execution and may include other writers.' } : {}) } : {}),
      files: files.slice(offset, offset + 100), total: files.length, nextOffset: offset + 100 < files.length ? offset + 100 : null,
      content: input.path ? { path: input.path, lines: Array.from({ length: count }, (_, n) => ({ id: `line-${lineOffset + n}`, kind: 'add' as const, newNumber: lineOffset + n + 1, text: evidence ? input.source === 'provider' ? 'Provider patch line' : 'Observed command line'
        : index > 0 ? `export const value${lineOffset + n} = true;` : 'A short test message.',
        ...(evidence ? { evidence: input.source === 'provider' ? 'Apply patch · patch-1' : 'Bash · shell-1' } : {}) })), nextOffset: lineOffset + count < totalLines ? lineOffset + count : null } : null } };
  }
  private changed(): void {
    this.version++;
    for (const done of [...this.waiting.values()]) done();
  }
  /** Change only provider-reported allowance while preserving drafts and transcript. */
  /** Publishes background work and runtime events through the ordinary read feed. */
  work(work: SessionChatState["work"], id = 101, provider?: string): void {
    const session = this.session(id);
    session.state = { ...session.state, work, ...(provider ? { provider } : {}) };
    this.changed();
  }
  /** Provider-shaped Activity; waiting work comes with the question it waits on. */
  activity(provider: string): void {
    const work = sessionActivityWork(provider);
    const session = this.session(101);
    session.state = {
      ...session.state,
      question: work.running.some((item) => item.status === "waiting") ? retryQuestion : null,
    };
    this.work(work, 101, provider);
  }
  agentReply: 'ready' | 'starting' | 'unavailable' | 'error' = 'ready';
  async agent(input: SessionChatAgentRead): Promise<BackendResult<SessionChatAgentPage>> {
    if (this.agentReply === 'error') return { ok: false, error: { code: 'transport', message: 'The agent transcript could not be read. Try again.' } };
    const work = this.session(input.sessionId).state.work;
    const active = work?.running.find(item => item.agentId === input.agentId);
    const assignment = 'Check the retry claim boundary. Reproduce simultaneous requests and report any unsafe paths.';
    return { ok: true, value: {
      agentId: input.agentId, label: active?.label ?? 'Review concurrency boundary',
      ...(active?.title ? { title: active.title, ...(active.agentName ? { agentName: active.agentName } : {}), ...(active.role ? { role: active.role } : {}) } : {}),
      status: active?.status ?? 'completed', prompt: assignment,
      model: active?.model ?? 'worker-model', context: active?.context ?? { tokens: 28000, limit: 128000, percentage: 22 },
      items: this.agentReply !== 'ready' ? [] : input.before ? [
        item('agent-assignment', 'user', assignment),
        item('earlier-assignment', 'user', 'Inspect the payment retry handler.'),
      ] : [
        item('agent-thinking', 'thinking', 'Two requests can race between the claim insert and the payment call. The unique index should make the second insert fail and fall back to reading the existing claim.'),
        item('agent-step', 'assistant', 'The claim is created before the payment call. I am checking the unique constraint and delayed retry path.'),
        item('agent-read', 'tool_use', '', { toolId: 'agent-read', toolName: 'Read', toolKind: 'read', input: '{"file_path":"src/payments/retry-claims.ts"}' }),
        item('agent-result', 'tool_result', 'The claim uses a unique constraint on the idempotency key.', { toolId: 'agent-read' }),
        item('agent-test', 'tool_use', '', { toolId: 'agent-test', toolName: 'Bash', toolKind: 'bash', input: '{"command":"pnpm test retry-claims --runInBand"}' }),
        item('agent-test-result', 'tool_result', 'PASS src/payments/retry-claims.spec.ts\n  ✓ shares one claim across concurrent requests (41 ms)', { toolId: 'agent-test' }),
        item('agent-answer', 'assistant', 'The transaction boundary is safe. Both requests share the original claim.\n\n```ts\nconst claim = await retries.claim(key);\n```'),
      ], before: input.before || this.agentReply !== 'ready' ? null : 'earlier', availability: this.agentReply === 'ready' ? 'available' : this.agentReply, message: '',
    } };
  }
  usage(planUsage: SessionChatState["planUsage"], id = 101): void {
    const session = this.session(id);
    session.state = { ...session.state, provider: planUsage?.provider ?? session.state.provider, planUsage };
    this.changed();
  }
  cancel(id: string): void {
    this.heldReads.get(id)?.();
    this.waiting.get(id)?.();
    const detail = this.heldToolDetails.get(id);
    if (detail) {
      this.toolDetailsCancelled++;
      detail();
    }
  }
  private readsHeld = false;
  private readonly heldReads = new Map<string, () => void>();
  /** Controlled transport latency for first-frame/session-switch regressions. */
  holdReads(held: boolean): void {
    this.readsHeld = held;
    if (!held) for (const done of [...this.heldReads.values()]) done();
  }
  /** Replay a bounded recorded page without importing task data into production. */
  seed(id: number, page: Pick<SessionChatPage, 'items' | 'state' | 'leadingPrompt'>): void {
    this.sessions.set(id, { items: [...(page.leadingPrompt ? [page.leadingPrompt] : []), ...page.items], state: page.state });
    this.changed();
  }
  private readonly turnActivities = new Map<string, readonly SessionChatRecord[]>();
  private readonly turnTimelines = new Map<string, readonly SessionChatTurnTimelineRow[]>();
  private readonly heldActivity = new Set<() => void>();
  private workBehavior: 'ready' | 'held' | 'failed' | 'too-large' = 'ready';
  private readonly turnWorkBehaviors = new Map<string, typeof this.workBehavior>();
  turnWorkReads = 0;

  seedTurnWork(sessionId: number, turnId: string, records: readonly SessionChatRecord[]): void {
    this.turnActivities.set(`${sessionId}/${turnId}`, records);
  }
  seedTurnTimeline(sessionId: number, turnId: string, timeline: readonly SessionChatTurnTimelineRow[]): void {
    this.turnTimelines.set(`${sessionId}/${turnId}`, timeline);
  }

  turnWorkBehavior(behavior: typeof this.workBehavior, turnId?: string): void {
    if (turnId) {
      this.turnWorkBehaviors.set(turnId, behavior);
      return;
    }
    this.workBehavior = behavior;
    if (behavior !== 'held') for (const release of this.heldActivity) release();
  }

  async turnWork(input: SessionChatTurnWorkRead): Promise<BackendResult<SessionChatTurnWorkReply>> {
    this.turnWorkReads++;
    const behavior = () => this.turnWorkBehaviors.get(input.turnId) ?? this.workBehavior;
    if (behavior() === 'held') await new Promise<void>(resolve => {
      const release = () => {
        this.heldActivity.delete(release);
        this.waiting.delete(input.requestId);
        resolve();
      };
      this.heldActivity.add(release);
      this.waiting.set(input.requestId, release);
    });
    if (behavior() === 'failed') return { ok: false, error: { code: 'transport', message: 'Activity read failed.' } };
    if (behavior() === 'too-large') return { ok: false, error: { code: 'http', status: 413, message: 'Activity is too large.' } };
    const { taskId, sessionId, turnId, revision, offset } = input;
    const key = `${sessionId}/${turnId}`;
    const summary = this.session(sessionId).items.find(item => item.id === turnId)?.completedTurn;
    const timeline = input.timeline ? this.turnTimelines.get(key) : undefined;
    if (timeline && revision === summary?.revision) {
      const rows = timeline.slice(offset);
      return { ok: true, value: { taskId, sessionId, turnId, revision, offset,
        timeline: rows, total: timeline.length, nextOffset: null } };
    }
    const work = this.turnActivities.get(key);
    if (!work || revision !== summary?.revision)
      return { ok: false, error: { code: 'http', status: 409, message: 'Activity changed.' } };
    const items = work.slice(offset, offset + (input.limit ?? SESSION_CHAT_TURN_WORK_LIMIT));
    const end = offset + items.length;
    return { ok: true, value: { taskId, sessionId, turnId, revision, offset,
      items, total: work.length, nextOffset: end < work.length ? end : null } };
  }
  private readonly toolEvidence = new Map<number, ReadonlyMap<string, SessionChatToolEvidence>>();
  private readonly heldToolDetails = new Map<string, () => void>();
  private detailBehavior: 'ready' | 'held' | 'failed' = 'ready';
  toolDetailsReads = 0;
  toolDetailsCancelled = 0;

  seedToolDetails(sessionId: number, records: readonly SessionChatToolEvidence[]): void {
    this.toolEvidence.set(sessionId, new Map(records.map(value => [value.id, value])));
  }

  toolDetailsBehavior(behavior: 'ready' | 'held' | 'failed'): void {
    this.detailBehavior = behavior;
    if (behavior !== 'held') for (const release of this.heldToolDetails.values()) release();
  }

  async toolDetails(input: SessionChatToolDetailsRead): Promise<BackendResult<SessionChatToolDetailsReply>> {
    this.toolDetailsReads++;
    if (this.detailBehavior === 'held') await new Promise<void>(resolve => {
      this.heldToolDetails.set(input.requestId, () => {
        this.heldToolDetails.delete(input.requestId);
        resolve();
      });
    });
    if (this.detailBehavior === 'failed') return { ok: false, error: { code: 'transport', message: 'Could not read tool details.' } };
    const { taskId, sessionId, item, result, turnId } = input;
    const records = this.toolEvidence.get(sessionId);
    const primary = records?.get(item.id);
    const output = result ? records?.get(result.id) : undefined;
    if (!primary || primary.revision !== item.revision || output?.revision !== result?.revision)
      return { ok: false, error: { code: 'http', status: 409, message: 'Tool evidence changed.' } };
    return { ok: true, value: { taskId, sessionId, item: primary, ...(output ? { result: output } : {}), ...(turnId ? { turnId } : {}) } };
  }

  async read(input: SessionChatRead): Promise<BackendResult<SessionChatPage>> {
    if (this.readsHeld) await new Promise<void>(resolve => {
      this.heldReads.set(input.requestId, () => { this.heldReads.delete(input.requestId); resolve(); });
    });
    if (input.after === String(this.version))
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiting.delete(input.requestId);
          resolve();
        };
        const timer = setTimeout(done, 8000);
        this.waiting.set(input.requestId, done);
      });
    const session = this.session(input.sessionId),
      limit = input.loadingMode === 'window' && !input.before && !input.following ? 320 : 80,
      start = input.following ? session.items.findIndex(item => item.id === input.following) + 1 : -1,
      end = input.following ? Math.min(session.items.length, start + limit) : input.before
        ? session.items.findIndex((item) => item.id === input.before)
        : session.items.length;
    const items = session.items.slice(start >= 0 ? start : Math.max(0, end - limit), end).map((item) =>
      item.truncated
        ? {
            ...item,
            text: item.text.slice(0, 16000) + "\n… [display shortened]",
          }
        : item,
    );
    const reset =
      !input.after || !!input.before || Number(input.after) < this.resetVersion;
    return {
      ok: true,
      value: {
        taskId: input.taskId,
        sessionId: input.sessionId,
        cursor: String(this.version),
        reset,
        leadingPrompt: items[0]?.kind === 'user' ? null : session.items.slice(0, start >= 0 ? start : Math.max(0, end - limit)).reverse().find(item => item.kind === 'user') ?? null,
        items: reset ? items : [],
        events: !reset ? items.map((item) => ({ type: "item", item })) : [],
        before: (start > 0 || end > limit) ? (items[0]?.id ?? null) : null,
        next: end < session.items.length ? (items.at(-1)?.id ?? null) : null,
        state: { ...session.state, presets: this.presets, presetDefault: this.defaultSnapshot(), presetEditing: this.presetEditing },
      },
    };
  }
  uploadState: "ready" | "failed" | "held" = "ready";
  private readonly uploadedFiles = new Map<string, { name: string; path: string; data: string[] }>();
  async upload(input: import('@elevenex/shared').ChatAttachmentUpload): Promise<BackendResult<import('@elevenex/shared').ChatAttachmentReceipt>> {
    if (this.uploadState === 'held') await new Promise<void>(resolve => { this.waiting.set(input.requestId, resolve); });
    if (this.uploadState === 'failed') return { ok: false, error: { code: 'transport', message: 'Upload failed' } };
    let file = this.uploadedFiles.get(input.id);
    if (!file) { file = { name: input.name, path: `/preview/chat-attachments/${input.sessionId}/${input.id}/${input.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, data: [] }; this.uploadedFiles.set(input.id, file); }
    file.data.push(input.data);
    const offset = input.offset + atob(input.data).length;
    return { ok: true, value: { id: input.id, offset, path: offset === input.size ? file.path : null } };
  }
  async media(input: import('@elevenex/shared').SessionChatMediaRead): Promise<BackendResult<import('@elevenex/shared').SessionChatMedia>> {
    const ref = this.session(input.sessionId).items.find(item => item.id === input.itemId)?.media?.find(media => media.id === input.mediaId);
    const file = [...this.uploadedFiles.values()].find(file => file.path === ref?.path);
    if (file) {
      const mime = ref?.kind === 'video' ? 'video/webm' : 'image/png';
      const binary = file.data.map(data => atob(data)).join('');
      return { ok: true, value: { itemId: input.itemId, mediaId: input.mediaId, source: `data:${mime};base64,${btoa(binary)}` } };
    }
    if (this.imageState === 'held') await new Promise<void>(resolve => {
      this.waiting.set(input.requestId, () => { this.waiting.delete(input.requestId); resolve(); });
    });
    return this.imageState === 'failed'
      ? { ok: false, error: { code: 'http', status: 404, message: 'Image unavailable.' } }
      : { ok: true, value: { itemId: input.itemId, mediaId: input.mediaId, source: previewChatImage() } };
  }
  async content(
    input: SessionChatContentRead,
  ): Promise<BackendResult<SessionChatContent>> {
    const item = this.session(input.sessionId).items.find(
      (item) => item.id === input.itemId,
    );
    const text = (input.part === "input" ? item?.input : item?.text) ?? "";
    const end = Math.min(text.length, input.offset + 16000);
    return {
      ok: true,
      value: {
        itemId: input.itemId,
        part: input.part,
        offset: input.offset,
        text: text.slice(input.offset, end),
        nextOffset: end < text.length ? end : null,
        total: text.length,
      },
    };
  }
  async command(
    input: SessionChatCommand,
  ): Promise<BackendResult<SessionChatCommandReply>> {
    if (this.commandFailure) {
      this.commandFailure = false;
      return {
        ok: false,
        error: {
          code: "outcome-unknown",
          message:
            "The send may have completed. Check delivery before trying again.",
        },
      };
    }
    const session = this.session(input.sessionId),
      action = input.action;
    if (action.type === 'mark-seen') {
      if (session.state.unseenCompletionAt === action.completionAt) {
        session.state = { ...session.state, unseenCompletionAt: null }; this.changed();
      }
      return { ok: true, value: { accepted: true } };
    }
    if (action.type === 'edit-prompt') {
      const index = session.items.findIndex(item => item.id === action.itemId && item.editable);
      const original = session.items[index];
      if (!original || action.revision !== this.version.toString(16).padStart(64, '0'))
        return { ok: false, error: { code: 'http', status: 409, message: 'The conversation changed. Refresh the edit details before resending.' } };
      const prompt = { ...original, id: 'revised-' + this.version, text: action.text };
      session.items = [...session.items.slice(0, index), prompt, item('revised-reply', 'assistant', 'I’ll verify the revised retry scenario.')];
      session.state = { ...session.state, historyRewrite: crypto.randomUUID() };
      this.changed();
      this.resetVersion = this.version;
      return { ok: true, value: { accepted: true } };
    }
    let defaultChange: SessionChatCommandReply['defaultChange'];
    if (action.type === 'preset-reorder' || action.type === 'preset-update' ||
        action.type === 'preset-delete' || action.type === 'preset-restore') {
      if (action.expectedRevision !== this.defaultSnapshot().revision)
        return { ok: false, error: { code: 'http', status: 409, message: 'The saved presets changed. Refresh before trying again.' } };
      let position = -1;
      if (action.type === 'preset-reorder') {
        const byId = new Map(this.presets.map(preset => [preset.id, preset]));
        this.presets = action.ids.map(id => byId.get(id)!);
      } else if (action.type === 'preset-delete') {
        position = this.presets.findIndex(preset => preset.id === action.id);
        if (position < 0) return { ok: false, error: { code: 'http', status: 404, message: 'Preset unavailable' } };
        const replacingDefault = this.defaultSnapshot().id === action.id;
        this.presets = this.presets.filter(preset => preset.id !== action.id);
        this.defaultIds = this.defaultIds.filter(id => id !== action.id);
        const fallback = replacingDefault && this.presets[0];
        if (fallback) {
          this.defaultProvider = fallback.provider;
          this.defaultIds = [...this.defaultIds.filter(id => this.presets.find(preset => preset.id === id)?.provider !== fallback.provider), fallback.id];
        }
      } else {
        const catalog = this.catalogData(action.provider);
        const preset: SessionChatPreset = {
          id: action.id, name: action.name, provider: action.provider, providerLabel: catalog.label,
          model: action.model, modelLabel: catalog.models.find(model => model.id === action.model)?.label ?? 'Provider default',
          reasoning: action.reasoning, fast: action.fast,
        };
        if (action.type === 'preset-update') {
          const original = this.presets.find(item => item.id === preset.id);
          if (original && original.provider !== preset.provider) {
            if (this.defaultSnapshot().id === original.id) {
              this.defaultProvider = preset.provider;
              this.defaultIds = this.defaultIds.filter(id => this.presets.find(item => item.id === id)?.provider !== preset.provider);
            } else this.defaultIds = this.defaultIds.filter(id => id !== action.id);
          }
          this.presets = this.presets.map(item => item.id === preset.id ? preset : item);
        } else {
          this.presets = [...this.presets.slice(0, action.position), preset, ...this.presets.slice(action.position)];
          this.defaultProvider = action.defaultProvider;
          this.defaultIds = action.defaultIds;
        }
      }
      this.defaultVersion++;
      this.changed();
      return { ok: true, value: { accepted: true, ...(position < 0 ? {} : {
        presetRemoval: { position, revision: this.defaultSnapshot().revision },
      }) } };
    } else if (action.type === 'preset-default-restore') {
      if (action.expectedRevision !== this.defaultSnapshot().revision)
        return { ok: false, error: { code: 'http', status: 409, message: 'The default changed. Refresh before trying again.' } };
      this.defaultProvider = action.provider; this.defaultIds = [...action.defaultIds]; this.defaultVersion++;
    } else if (action.type === 'preset' || action.type === 'save-preset' || action.type === 'preset-default') {
      if (session.state.providerLocked || session.state.provider !== action.expectedProvider)
        return { ok: false, error: { code: 'http', status: 409, message: 'This conversation has already started.' } };
      const before = this.defaultSnapshot();
      if (action.type === 'preset' && action.expectedMix &&
        (action.expectedMix.revision !== before.revision || action.expectedMix.model !== session.state.model ||
        action.expectedMix.reasoning !== session.state.reasoning || action.expectedMix.fast !== !!session.state.fast))
        return { ok: false, error: { code: 'http', status: 409, message: 'This chat’s agent settings changed.' } };
      const makeDefault = action.type === 'preset-default' || (action.type === 'save-preset' && action.makeDefault === true);
      const revision = action.type === 'preset-default' ? action.expectedRevision : action.type === 'save-preset' ? action.expectedDefaultRevision : undefined;
      if (makeDefault && revision !== before.revision)
        return { ok: false, error: { code: 'http', status: 409, message: 'The default changed. Refresh before trying again.' } };
      let preset = this.presets.find(p => p.id === action.id);
      if (action.type === 'save-preset') {
        preset = { id: action.id, name: action.name, provider: action.provider ?? action.expectedProvider,
          providerLabel: session.state.providers?.find(p => p.id === (action.provider ?? action.expectedProvider))?.label ?? (action.provider ?? action.expectedProvider),
          model: action.model, modelLabel: this.catalogData(action.provider ?? action.expectedProvider).models.find(m => m.id === action.model)?.label ?? 'Provider default',
          reasoning: action.reasoning, fast: action.fast };
        this.presets = [preset, ...this.presets.filter(p => p.id !== action.id)];
        if (!makeDefault) this.defaultVersion++;
      }
      if (!preset) return { ok: false, error: { code: 'http', message: 'Preset unavailable' } };
      if (preset.provider !== session.state.provider)
        await this.command({ ...input, action: { type: 'provider', provider: preset.provider, expectedProvider: session.state.provider } });
      session.state = { ...session.state, model: preset.model, reasoning: preset.reasoning, fast: preset.fast };
      if (makeDefault) {
        this.defaultIds = [...this.defaultIds.filter(id => this.presets.find(p => p.id === id)?.provider !== preset.provider), preset.id];
        this.defaultProvider = preset.provider; this.defaultVersion++;
        defaultChange = { before, after: this.defaultSnapshot() };
      }
    } else if (action.type === "provider") {
      if (
        session.state.providerLocked ||
        session.state.provider !== action.expectedProvider
      )
        return {
          ok: false,
          error: {
            code: "http",
            status: 409,
            message: "This conversation has already started.",
          },
        };
      session.state = {
        ...previewChatState(),
        provider: action.provider,
        model:
          action.provider === "claude"
            ? "sonnet"
            : action.provider === "codex"
              ? "gpt-6"
              : null,
        models:
          action.provider === "claude"
            ? [
                {
                  id: "sonnet",
                  label: "Claude Sonnet",
                  reasoningEfforts: ["low", "medium", "high"],
                  supportsFastMode: false,
                },
              ]
            : action.provider === "codex"
              ? [
                  {
                    id: "gpt-6",
                    label: "GPT-6",
                    reasoningEfforts: ["low", "medium", "high", "xhigh"],
                    supportsFastMode: true,
                  },
                ]
              : [],
      };
    } else if (action.type === "send") {
      session.state = { ...session.state, providerLocked: true };
      if (action.queue)
        session.state = {
          ...session.state,
          queue: [
            ...session.state.queue,
            { id: `queue-${this.version}`, text: action.text },
          ],
        };
      else {
        const refs = [...action.text.matchAll(/^\[([^\]]+)\]\(<([^>]+)>\)/gm)].map((match, index) => ({ id: String(index), path: match[2]!, caption: match[1]!, inline: false, kind: /\.(png|jpe?g|gif|webp)$/i.test(match[2]!) ? 'image' as const : /\.(mp4|webm|mov)$/i.test(match[2]!) ? 'video' as const : 'file' as const }));
        const mentions = action.sessionIds?.map(sessionId => ({ sessionId, title: sessionId === 102 ? 'Review the race condition' : `Session ${sessionId}` }));
        const receipt = item(`sent-${this.version}`, "user", action.text, { media: refs, mentions, timestamp: new Date().toISOString() });
        const delayed = this.delayedReceipts;
        if (!delayed) session.items.push(receipt);
        session.items.push(item(`reply-${this.version}`, "assistant", "", { timestamp: new Date().toISOString() }));
        session.state = {
          ...session.state,
          phase: "running",
          canInterrupt: true,
        };
        const reply = session.items.at(-1)!;
        const words =
          "I’ll check the relevant implementation and verify the result. You can keep typing while I work.".split(
            " ",
          );
        let index = 0;
        const append = () => {
          if (session.state.phase !== "running") return;
          session.items = session.items.map((item) =>
            item.id === reply.id
              ? { ...item, text: words.slice(0, index + 1).join(" ") }
              : item,
          );
          index++;
          if (delayed && index === (delayed === 'completion' ? words.length : 10)) {
            const replyIndex = session.items.findIndex(
              (item) => item.id === reply.id,
            );
            session.items.splice(replyIndex, 0, receipt);
          }
          if (index >= words.length)
            session.state = {
              ...session.state,
              phase: "idle",
              canInterrupt: false,
            };
          else {
            const timer = setTimeout(() => {
              this.timers.delete(timer);
              append();
            }, 90);
            this.timers.add(timer);
          }
          this.changed();
        };
        append();
      }
    } else if (action.type === "stop")
      session.state = { ...session.state, phase: "idle", canInterrupt: false };
    else if (action.type === "background-agent") {
      const work = session.state.work;
      if (work) session.state = { ...session.state, work: { ...work, running: work.running.map(item => item.agentId === action.id ? { ...item, background: true, canBackground: false } : item) } };
    }
    else if (action.type === "stop-background") {
      const work = session.state.work;
      const stopped = work?.running.find((item) => item.id === action.id);
      if (!work || !stopped)
        return { ok: false, error: { code: "http", status: 409, message: "This background work already finished." } };
      const event: SessionChatWorkEvent = { id: `finished:${action.id}`, kind: "finished", tone: "info", title: `${stopped.label} stopped`, detail: "", at: new Date().toISOString() };
      session.state = {
        ...session.state,
        work: {
          running: work.running.filter((item) => item.id !== action.id),
          recent: [
            event,
            ...work.recent,
          ].slice(0, 12),
        },
      };
    }
    else if (action.type === "permission")
      session.state = {
        ...session.state,
        permission: null,
        phase: "idle",
        canInterrupt: false,
      };
    else if (action.type === "answer")
      session.state = {
        ...session.state,
        question: null,
        phase: "idle",
        canInterrupt: false,
      };
    else if (action.type === "cancel-queued")
      session.state = {
        ...session.state,
        queue: session.state.queue.filter((item) => item.id !== action.id),
      };
    else if (action.type === "steer-queued" || action.type === "resume-queue") {
      session.state = { ...session.state, queuePaused: false };
      if (action.type === 'steer-queued' || session.state.phase === 'idle')
        this.dispatchQueuedPrompt(input.sessionId, action.type === 'steer-queued' ? action.id : undefined);
      if (!this.delayedReceipts) this.finishQueuedPrompt(input.sessionId);
    }
    else if (action.type === "plan")
      session.state = { ...session.state, plan: action.enabled };
    else if (action.type === "model")
      session.state = { ...session.state, model: action.model };
    else if (action.type === "reasoning")
      session.state = { ...session.state, reasoning: action.effort };
    else if (action.type === "fast")
      session.state = { ...session.state, fast: action.enabled };
    else if (action.type === "permission-mode")
      session.state = { ...session.state, permissionMode: action.mode };
    this.changed();
    return { ok: true, value: { accepted: true, ...(defaultChange ? { defaultChange } : {}) } };
  }
}
