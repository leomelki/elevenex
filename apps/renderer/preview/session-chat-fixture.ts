import type { DestroyRef } from "@angular/core";
import type {
  BackendResult,
  SessionChatChangesRead,
  SessionChatChangesPage,
  SessionChatCommand,
  SessionChatContent,
  SessionChatContentRead,
  SessionChatItem,
  SessionChatPage,
  SessionChatRead,
  SessionChatState,
  SessionChatPreset,
  SessionChatCommandReply,
  SessionChatCatalog,
  SessionChatCatalogRead,
  SessionChatPresetDefault,
} from "@elevenex/shared";

const savedPresets: readonly SessionChatPreset[] = [
  { id: 'deep', name: 'Deep work', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6', modelLabel: 'GPT-6', reasoning: 'high', fast: false },
  { id: 'quick', name: 'Quick pass', provider: 'codex', providerLabel: 'Codex', model: 'gpt-6', modelLabel: 'GPT-6', reasoning: 'low', fast: true },
  { id: 'explore', name: 'Explore', provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet', modelLabel: 'Claude Sonnet', reasoning: 'medium', fast: false },
];
const stamp = "2026-10-28T10:20:00.000Z";
export const previewChatState = (): SessionChatState => ({
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
  ),
];
/** Harness-shaped fixtures stay outside the production import graph. */
export class SessionChatFixture {
  private presets = [...savedPresets];
  private defaultProvider = 'codex';
  private defaultIds: readonly string[] = ['deep'];
  private defaultVersion = 1;
  private defaultSnapshot(): SessionChatPresetDefault {
    return { id: this.presets.find(p => p.provider === this.defaultProvider && this.defaultIds.includes(p.id))?.id ?? null,
      provider: this.defaultProvider, defaultIds: [...this.defaultIds], revision: this.defaultVersion.toString(16).padStart(64, '0') };
  }
  private catalogDelay = 0;
  private catalogFailure = false;
  catalogBehavior(delay: number, fail = false): void { this.catalogDelay = Math.min(5000, Math.max(0, delay)); this.catalogFailure = fail; }
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
  private commandFailure = false;
  private delayedReceipts = false;
  deferUserReceipts(value: boolean): void {
    this.delayedReceipts = value;
  }
  constructor(destroy: DestroyRef) {
    destroy.onDestroy(() => {
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
  scenario(
    mode:
      | "permission"
      | "question"
      | "running"
      | "failed"
      | "history"
      | "ready"
      | "unknown"
      | "long"
      | "reply-boundaries",
    id = 101,
  ): void {
    const session = this.session(id);
    session.items = opening();
    session.state = previewChatState();
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
        question: {
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
        },
      };
    if (mode === "running") {
      session.items = session.items.slice(0, 6);
      session.state = {
        ...session.state,
        phase: "running",
        canInterrupt: true,
        activity: [
          {
            id: "reviewer",
            label: "Review concurrency boundary",
            detail: "Subagent running",
          },
        ],
      };
    }
    if (mode === "failed")
      session.state = {
        ...session.state,
        phase: "error",
        error: "The provider disconnected. Your conversation is saved.",
      };
    if (mode === "history")
      session.items = Array.from({ length: 240 }, (_, i) =>
        item(
          `history-${i}`,
          i % 2 ? "assistant" : "user",
          i % 2
            ? `Verified request ${Math.floor(i / 2)}.`
            : `Check request ${Math.floor(i / 2)}.`,
        ),
      );
    if (mode === "long")
      session.items[6] = {
        ...session.items[6]!,
        text: Array.from(
          { length: 1600 },
          (_, i) => "Verified concurrent request " + i + ": passed",
        ).join("\n"),
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
  private changeMode: 'created' | 'many' | 'empty' | 'failed' = 'created';
  changedFiles(mode: 'created' | 'many' | 'empty' | 'failed', id = 101): void {
    this.changeMode = mode;
    const files = this.changeRows();
    const session = this.session(id);
    session.state = { ...previewChatState(), providerLocked: true };
    session.items = [
      item('change-prompt', 'user', 'Create a small file to test the agent.'),
      item('change-answer', 'assistant', mode === 'empty' ? 'No files changed.' : 'Created `skill-test.txt` with a short test message.'),
      item('change-capture', 'system', '', { changes: { total: files.length, files: files.slice(0, 200) } }),
    ];
    this.changed(); this.resetVersion = this.version;
  }
  private changeRows() {
    return Array.from({ length: this.changeMode === 'empty' ? 0 : this.changeMode === 'many' ? 1001 : 1 }, (_, i) => ({ path: i ? `src/example-${i}.ts` : 'skill-test.txt', status: 'A' as const, add: i ? 401 : 1, del: 0 }));
  }
  async changes(input: SessionChatChangesRead): Promise<BackendResult<SessionChatChangesPage>> {
    if (this.changeMode === 'failed') return { ok: false, error: { code: 'transport', message: 'Could not load the reply changes.' } };
    const files = this.changeRows(), index = input.path ? files.findIndex(file => file.path === input.path) : -1;
    const offset = index >= 0 ? Math.floor(index / 100) * 100 : input.offset;
    const lineOffset = input.lineOffset ?? 0;
    const totalLines = index > 0 ? 401 : 1;
    const count = Math.min(400, Math.max(0, totalLines - lineOffset));
    return { ok: true, value: { turnId: input.turnId, revision: 'a'.repeat(64), offset, files: files.slice(offset, offset + 100), total: files.length, nextOffset: offset + 100 < files.length ? offset + 100 : null,
      content: input.path ? { path: input.path, lines: Array.from({ length: count }, (_, n) => ({ id: `line-${lineOffset + n}`, kind: 'add' as const, newNumber: lineOffset + n + 1, text: index > 0 ? `export const value${lineOffset + n} = true;` : 'A short test message.' })), nextOffset: lineOffset + count < totalLines ? lineOffset + count : null } : null } };
  }
  private changed(): void {
    this.version++;
    for (const done of [...this.waiting.values()]) done();
  }
  /** Change only provider-reported allowance while preserving drafts and transcript. */
  usage(planUsage: SessionChatState["planUsage"], id = 101): void {
    const session = this.session(id);
    session.state = { ...session.state, provider: planUsage?.provider ?? session.state.provider, planUsage };
    this.changed();
  }
  cancel(id: string): void {
    this.waiting.get(id)?.();
  }
  async read(input: SessionChatRead): Promise<BackendResult<SessionChatPage>> {
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
      end = input.before
        ? session.items.findIndex((item) => item.id === input.before)
        : session.items.length;
    const items = session.items.slice(Math.max(0, end - 80), end).map((item) =>
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
        items: reset ? items : [],
        events: !reset ? items.map((item) => ({ type: "item", item })) : [],
        before: end > 80 ? (items[0]?.id ?? null) : null,
        state: { ...session.state, presets: this.presets, presetDefault: this.defaultSnapshot() },
      },
    };
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
    let defaultChange: SessionChatCommandReply['defaultChange'];
    if (action.type === 'preset-default-restore') {
      if (action.expectedRevision !== this.defaultSnapshot().revision)
        return { ok: false, error: { code: 'http', status: 409, message: 'The default changed. Refresh before trying again.' } };
      this.defaultProvider = action.provider; this.defaultIds = [...action.defaultIds]; this.defaultVersion++;
    } else if (action.type === 'preset' || action.type === 'save-preset' || action.type === 'preset-default') {
      if (session.state.providerLocked || session.state.provider !== action.expectedProvider)
        return { ok: false, error: { code: 'http', status: 409, message: 'This conversation has already started.' } };
      const before = this.defaultSnapshot();
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
        const receipt = item(`sent-${this.version}`, "user", action.text);
        const delayed = this.delayedReceipts;
        if (!delayed) session.items.push(receipt);
        session.items.push(item(`reply-${this.version}`, "assistant", ""));
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
          if (delayed && index === 10) {
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
    else if (action.type === "cancel-queued" || action.type === "steer-queued")
      session.state = {
        ...session.state,
        queue: session.state.queue.filter((item) => item.id !== action.id),
      };
    else if (action.type === "resume-queue")
      session.state = { ...session.state, queuePaused: false };
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
