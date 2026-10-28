import type { DestroyRef } from "@angular/core";
import type {
  BackendResult,
  SessionChatCommand,
  SessionChatContent,
  SessionChatContentRead,
  SessionChatItem,
  SessionChatPage,
  SessionChatRead,
  SessionChatState,
} from "@elevenex/shared";

const stamp = "2026-10-28T10:20:00.000Z";
export const previewChatState = (): SessionChatState => ({
  provider: "codex",
  providers: [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "pi", label: "Pi" },
    { id: "opencode", label: "OpenCode" },
  ],
  providerLocked: false,
  phase: "idle",
  canInterrupt: false,
  error: null,
  model: "gpt-6",
  models: [
    { id: "gpt-6", label: "GPT-6" },
    { id: "claude", label: "Claude" },
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
  private changed(): void {
    this.version++;
    for (const done of [...this.waiting.values()]) done();
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
        state: session.state,
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
  ): Promise<BackendResult<{ readonly accepted: true }>> {
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
    if (action.type === "provider") {
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
            ? [{ id: "sonnet", label: "Claude Sonnet" }]
            : action.provider === "codex"
              ? [{ id: "gpt-6", label: "GPT-6" }]
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
    else if (action.type === "permission-mode")
      session.state = { ...session.state, permissionMode: action.mode };
    this.changed();
    return { ok: true, value: { accepted: true } };
  }
}
