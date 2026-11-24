import type {
  ClaudeBackgroundWorkItem,
  ClaudeTaskState,
} from '../claude-runtime/claude-runtime.types.js';
import { acpObject } from './acp-stdio.js';
import { acpText } from './antigravity-acp.js';

const COMMAND_TIMEOUT = 30 * 60_000;
const WAKE_GRACE = 15_000;
const REPLY_TIMEOUT = 2 * 60_000;
const TOOL_LIMIT = 128;

interface ToolOwner {
  rowId: number;
  turnId: string;
}

interface NativeWork {
  owner?: ToolOwner;
  item: ClaudeBackgroundWorkItem;
  daemon: boolean;
  expiresAt: number;
}

/** The prompt response ends the RPC. The work and any resulting reply can outlive it. */
export class AntigravityBackground {
  private readonly work = new Map<string, NativeWork>();
  private agents: ClaudeBackgroundWorkItem[] = [];
  private readonly recent = new Map<string, ClaudeTaskState>();
  private changed?: () => void;
  private deadline = 0;
  private replyUntil = 0;
  private graceUntil = 0;

  get items() {
    return [...[...this.work.values()].map(({ item }) => item), ...this.agents];
  }

  get finished() {
    return [...this.recent.values()];
  }

  get active() {
    return this.work.size > 0 || this.agents.length > 0;
  }

  owner(nativeId: string) {
    return this.work.get(nativeId)?.owner;
  }

  observe(
    update: Record<string, unknown>,
    owner?: ToolOwner,
    foreground = false,
  ) {
    if (
      update.sessionUpdate !== 'tool_call' &&
      update.sessionUpdate !== 'tool_call_update'
    )
      return false;
    const id = acpText(update.toolCallId, 256);
    if (!id) return false;
    if (update.status === 'completed' || update.status === 'failed') {
      const previous = this.work.get(id);
      if (!previous) return false;
      this.work.delete(id);
      if (!foreground) {
        const output = acpObject(update.rawOutput);
        this.remember(
          id,
          previous,
          update.status,
          acpText(output.combinedOutput ?? output.output, 400),
        );
      }
      if (!foreground && !previous.daemon)
        this.graceUntil = Date.now() + WAKE_GRACE;
      this.changed?.();
      return true;
    }
    const current = this.work.get(id);
    const title = acpText(update.title, 200);
    const scheduled = title === 'Run schedule' || title === 'Running schedule';
    if (
      !current &&
      ((!scheduled && update.kind !== 'execute') ||
        update.status !== 'in_progress' ||
        this.work.size >= TOOL_LIMIT)
    )
      return false;
    if (update.status === 'pending') return false;
    if (!current) this.recent.delete(id);
    const input = acpObject(update.rawInput);
    const time = new Date().toISOString();
    const duration = input.DurationSeconds;
    const scheduledUntil =
      scheduled &&
      typeof duration === 'number' &&
      Number.isSafeInteger(duration) &&
      duration > 0
        ? Math.min(
            Number.MAX_SAFE_INTEGER,
            Date.now() + duration * 1000 + COMMAND_TIMEOUT,
          )
        : 0;
    this.work.set(id, {
      owner: current?.owner ?? owner,
      expiresAt: Math.max(
        current?.expiresAt ?? 0,
        scheduledUntil,
        Date.now() + COMMAND_TIMEOUT,
      ),
      daemon:
        typeof input.IsDaemon === 'boolean'
          ? input.IsDaemon
          : (current?.daemon ?? false),
      item: {
        id: `task:${id}`,
        kind: 'task',
        label: title || current?.item.label || 'Running command',
        detail:
          acpText(input.CommandLine ?? input.Command ?? input.command, 400) ||
          current?.item.detail,
        startedAt: current?.item.startedAt ?? time,
        updatedAt: time,
      },
    });
    this.changed?.();
    return true;
  }

  private remember(
    id: string,
    work: NativeWork,
    status: ClaudeTaskState['status'],
    summary?: string,
  ) {
    const { item } = work;
    this.recent.set(id, {
      taskId: id,
      description: item.detail || item.label,
      startedAt: item.startedAt,
      updatedAt: new Date().toISOString(),
      status,
      isBackgrounded: true,
      summary,
    });
    if (this.recent.size > 32) {
      const oldest = this.recent.keys().next().value;
      if (oldest) this.recent.delete(oldest);
    }
  }

  setAgents(items: ClaudeBackgroundWorkItem[]) {
    if (this.deadline && this.agents.length && !items.length)
      this.graceUntil = Date.now() + WAKE_GRACE;
    this.agents = items;
    this.changed?.();
  }

  /** A reply started by agy has no session/prompt response. */
  replyStarted() {
    this.replyUntil = Date.now() + REPLY_TIMEOUT;
    this.graceUntil = 0;
    this.changed?.();
  }

  replyEnded() {
    if (!this.replyUntil) return;
    this.replyUntil = 0;
    this.graceUntil = 0;
    this.changed?.();
  }

  async settle(
    signal: AbortSignal,
    waitingForDecision: () => boolean,
    detached = false,
  ) {
    this.deadline = Date.now() + COMMAND_TIMEOUT;
    if (detached && !this.replyUntil) this.replyStarted();
    try {
      while (!signal.aborted) {
        const now = Date.now();
        const pendingUntil = [...this.work.values()].reduce(
          (until, item) =>
            item.daemon ? until : Math.max(until, item.expiresAt),
          this.agents.length ? this.deadline : 0,
        );
        const until = Math.max(this.replyUntil, this.graceUntil, pendingUntil);
        if (until <= now && !waitingForDecision()) {
          this.agents = [];
          for (const [id, item] of this.work)
            if (!item.daemon) {
              this.work.delete(id);
              this.remember(id, item, 'unavailable');
            }
          return;
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', wake);
            this.changed = undefined;
            resolve();
          };
          const timer = setTimeout(
            wake,
            until > now ? Math.min(until - now, 2_147_483_647) : REPLY_TIMEOUT,
          ).unref();
          this.changed = wake;
          signal.addEventListener('abort', wake, { once: true });
        });
      }
    } finally {
      this.deadline = this.graceUntil = this.replyUntil = 0;
    }
  }

  decisionChanged() {
    this.changed?.();
  }

  clear(status: 'stopped' | 'unavailable' = 'unavailable') {
    for (const [id, item] of this.work) this.remember(id, item, status);
    this.work.clear();
    this.agents = [];
    this.replyEnded();
    this.changed?.();
  }
}
