import type { AgentRuntimeEvent } from '../agent-runtime/agent-runtime.types.js';
import { record } from './desktop-chat-tool-outcome.js';
import { splitSessionAgentPrompt } from '../sessions/session-agent-message.js';

const LIMIT = 2048;
const PROGRESS_INTERVAL = 600;
const RECENT_TOOL_IDS = 64;
export const activityLine = (value: unknown) => typeof value === 'string'
  ? value.trim().slice(0, 600).replace(/\s+/g, ' ').slice(0, 300) : '';
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function deliveredMessage(value: unknown): string | undefined {
  const item = record(value);
  return item.kind === 'user' && typeof item.content === 'string'
    ? splitSessionAgentPrompt(item.content).sender?.messageId : undefined;
}

interface Progress {
  detail: string;
  startedAt: string | null;
  endedAt: string | null;
  model?: string;
  effort?: string;
  toolUses?: number;
  tokens?: number;
  paused?: boolean;
  interrupted?: boolean;
  toolIds?: readonly string[];
  deliveries?: readonly string[];
  message?: { readonly id: string; readonly text: string };
}

function toolDetail(item: Record<string, unknown>): string {
  const input = record(item.toolInput);
  const path = activityLine(input.file_path ?? input.path);
  switch (item.toolKind) {
    case 'read': return path ? 'Reading ' + path : 'Reading files';
    case 'write':
    case 'edit': return path ? 'Editing ' + path : 'Editing files';
    case 'grep':
    case 'glob': return 'Searching the workspace';
    case 'bash': return 'Running a command';
    default: {
      const label = activityLine(item.toolDisplayName ?? item.toolName);
      return label ? 'Using ' + label : '';
    }
  }
}

/** Retains only scalar activity. One timer coalesces progress bursts across all selected chats. */
export class DesktopDelegationActivity {
  private readonly entries = new Map<number, Progress>();
  private readonly pending = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(id: number, semantic: boolean) => void>();

  observe(listener: (id: number, semantic: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: number): Readonly<Progress> | undefined {
    return this.entries.get(id);
  }

  private publish(id: number, semantic: boolean): void {
    for (const listener of this.listeners) listener(id, semantic);
  }

  change(id: number): void {
    this.pending.delete(id);
    this.publish(id, true);
  }

  forget(id: number): void {
    this.entries.delete(id);
    this.change(id);
  }

  interrupted(id: number): void {
    const retained = this.entries.get(id);
    this.entries.set(id, {
      ...retained, detail: '', interrupted: true,
      startedAt: retained?.startedAt ?? null, endedAt: new Date().toISOString(),
    });
    this.trim();
    this.change(id);
  }

  private trim(): void {
    while (this.entries.size > LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.pending.delete(oldest);
    }
  }

  update(event: AgentRuntimeEvent, previous: string | undefined, state: string | undefined, semantic: boolean): void {
    const { sessionId } = event.payload;
    const raw = record(event.payload);
    const old = this.entries.get(sessionId);
    const active = state === 'running' || state === 'attention';
    const first = active && (!old?.startedAt || old.endedAt !== null);
    // Some harnesses clear the sidebar hook before publishing their idle snapshot.
    const finished = state !== undefined && !active && !!old?.startedAt && old.endedAt === null;
    const snapshot = state !== undefined;
    const item = record(raw.item);
    const toolId = event.type === 'tool_use' && item.kind === 'tool_use' && typeof item.id === 'string'
      ? item.id.slice(0, 256) : undefined;
    const newTool = !!toolId && !old?.toolIds?.includes(toolId);
    const startingMessage = event.type === 'message_start';
    const messageIds = [
      ...(startingMessage ? [deliveredMessage(item)] : []),
      ...((event.type === 'runtime_snapshot' || event.type === 'session_snapshot') && Array.isArray(raw.liveItems)
        ? raw.liveItems.slice(-16).map(deliveredMessage) : []),
    ].filter((id): id is string => !!id && !old?.deliveries?.includes(id));
    const priorMessage = old?.message;
    const body = startingMessage && item.kind === 'assistant' && typeof item.id === 'string'
      ? { id: item.id.slice(0, 1000), text: typeof item.content === 'string' ? item.content.slice(0, 300) : '' }
      : event.type === 'message_delta' && priorMessage && priorMessage.id === raw.itemId && priorMessage.text.length < 300 &&
          typeof raw.delta === 'string'
        ? { ...priorMessage, text: priorMessage.text + raw.delta.slice(0, 300 - priorMessage.text.length) }
        : undefined;
    if (!snapshot && !newTool && !messageIds.length && !body) return;
    const said = activityLine(body?.text);
    const permission = record(raw.pendingPermissionRequest);
    const question = record(raw.pendingUserInputRequest);
    const questions = Array.isArray(question.questions) ? question.questions : [];
    const decision = state === 'attention' ? activityLine(
      permission.description ?? permission.title ?? question.message ?? record(questions[0]).question,
    ) : '';
    const error = state === 'failed' ? activityLine(raw.lastError) : '';
    const tool = newTool ? activityLine(toolDetail(item)) : '';
    const model = activityLine(raw.selectedModel).slice(0, 160) || old?.model;
    const effort = activityLine(raw.reasoningEffort).slice(0, 80) || old?.effort;
    const usage = record(raw.contextUsage);
    const now = () => new Date().toISOString();
    if (!old && !semantic && !tool && !body && !messageIds.length) return;
    const deliveries = messageIds.length
      ? [...new Set([...(old?.deliveries ?? []), ...messageIds])].slice(-8) : old?.deliveries;
    const next: Progress = {
      detail: error || decision || said || tool ||
        (first || (semantic && previous === 'attention') ? '' : old?.detail ?? ''),
      startedAt: first ? now() : old?.startedAt ?? null,
      endedAt: first ? null : finished ? now() : old?.endedAt ?? null,
      model, effort, deliveries,
      message: newTool || finished ? undefined : body ?? (first ? undefined : old?.message),
      toolUses: newTool ? (old?.toolUses ?? 0) + 1 : first ? undefined : old?.toolUses,
      tokens: number(usage.totalTokens) ?? (first ? undefined : old?.tokens),
      toolIds: first ? undefined : newTool ? [...(old?.toolIds ?? []).slice(1 - RECENT_TOOL_IDS), toolId] : old?.toolIds,
      paused: snapshot ? raw.queuePaused === true : old?.paused,
      interrupted: !first && old?.interrupted,
    };
    if (old && JSON.stringify(old) === JSON.stringify(next) && !semantic) return;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, next);
    this.trim();
    if (semantic || messageIds.length || finished) this.change(sessionId);
    else if (this.listeners.size) {
      this.pending.add(sessionId);
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        const updated = [...this.pending];
        this.pending.clear();
        for (const id of updated) this.publish(id, false);
      }, PROGRESS_INTERVAL).unref();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.entries.clear();
    this.listeners.clear();
  }
}
