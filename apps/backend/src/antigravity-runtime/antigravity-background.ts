import type { ClaudeBackgroundWorkItem } from '../claude-runtime/claude-runtime.types.js';
import { acpObject } from './acp-stdio.js';
import { acpText } from './antigravity-acp.js';

const COMMAND_TIMEOUT = 30 * 60_000;
const WAKE_GRACE = 8_000;
const REPLY_TIMEOUT = 2 * 60_000;
const TOOL_LIMIT = 128;

interface NativeWork {
  item: ClaudeBackgroundWorkItem;
  daemon: boolean;
}

/** The prompt response ends the RPC. The work and any resulting reply can outlive it. */
export class AntigravityBackground {
  private readonly work = new Map<string, NativeWork>();
  private changed?: () => void;
  private deadline = 0;
  private replyUntil = 0;
  private graceUntil = 0;

  get items() {
    return [...this.work.values()].map(({ item }) => item);
  }

  get active() {
    return this.work.size > 0;
  }

  observe(update: Record<string, unknown>) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
      return false;
    const id = acpText(update.toolCallId, 256);
    if (!id) return false;
    if (update.status === 'completed' || update.status === 'failed') {
      const previous = this.work.get(id);
      if (!previous) return false;
      this.work.delete(id);
      if (this.deadline && !previous.daemon) this.graceUntil = Date.now() + WAKE_GRACE;
      this.changed?.();
      return true;
    }
    const current = this.work.get(id);
    const title = acpText(update.title, 200);
    const scheduled = title === 'Run schedule' || title === 'Running schedule';
    if (!current && (!scheduled && update.kind !== 'execute' ||
        update.status !== 'in_progress' || this.work.size >= TOOL_LIMIT))
      return false;
    if (update.status === 'pending') return false;
    const input = acpObject(update.rawInput);
    const time = new Date().toISOString();
    this.work.set(id, {
      daemon: typeof input.IsDaemon === 'boolean' ? input.IsDaemon : current?.daemon ?? false,
      item: {
        id: `task:${id}`,
        kind: 'task',
        label: title || current?.item.label || 'Running command',
        detail: acpText(input.Command ?? input.command, 400) || current?.item.detail,
        startedAt: current?.item.startedAt ?? time,
        updatedAt: time,
      },
    });
    this.changed?.();
    return true;
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

  async settle(signal: AbortSignal, waitingForDecision: () => boolean, detached = false) {
    this.deadline = Date.now() + COMMAND_TIMEOUT;
    if (detached && !this.replyUntil) this.replyStarted();
    try {
      while (!signal.aborted) {
        const now = Date.now();
        const pending = [...this.work.values()].some(({ daemon }) => !daemon);
        const until = Math.max(this.replyUntil, this.graceUntil, pending ? this.deadline : 0);
        if (until <= now && !waitingForDecision()) {
          if (pending) {
            for (const [id, item] of this.work) if (!item.daemon) this.work.delete(id);
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
          const timer = setTimeout(wake, until > now ? until - now : REPLY_TIMEOUT).unref();
          this.changed = wake;
          signal.addEventListener('abort', wake, { once: true });
        });
      }
    } finally {
      this.deadline = this.graceUntil = this.replyUntil = 0;
    }
  }

  get settling() {
    return this.deadline !== 0;
  }

  decisionChanged() {
    this.changed?.();
  }

  clear() {
    this.work.clear();
    this.replyEnded();
    this.changed?.();
  }
}
