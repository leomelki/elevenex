import type {
  ClaudeSubagentState,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';

type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
export function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
/** Fernet transport envelopes are not a readable assignment or assistant response. */
export function readableText(value: unknown): string | undefined {
  const text = textValue(value);
  return text && !/^gAAAAA[A-Za-z0-9_-]{100,}={0,2}$/.test(text)
    ? text
    : undefined;
}
function json(value: unknown): RecordValue {
  try {
    return record(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    return {};
  }
}

const TOOLS: Record<string, string> = {
  spawnAgent: 'spawn_agent',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  wait: 'wait',
  waitAgent: 'wait_agent',
  closeAgent: 'close_agent',
  sendMessage: 'send_message',
  followupTask: 'followup_task',
  interruptAgent: 'interrupt_agent',
  listAgents: 'list_agents',
};
export function collaborationTool(value: unknown): string | undefined {
  const name = textValue(value)?.split('.').at(-1);
  return (
    name &&
    (Object.hasOwn(TOOLS, name)
      ? TOOLS[name]
      : Object.values(TOOLS).includes(name)
        ? name
        : undefined)
  );
}
export function executionStatus(
  value: unknown,
): ClaudeSubagentState['executionStatus'] {
  const raw = typeof value === 'string' ? value : Object.keys(record(value))[0];
  switch (raw) {
    case 'pendingInit':
    case 'pending_init':
      return 'pending';
    case 'running':
    case 'active':
    case 'inProgress':
      return 'running';
    case 'completed':
    case 'idle':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'errored':
    case 'failed':
    case 'systemError':
    case 'error':
      return 'error';
    case 'shutdown':
      return 'closed';
    case 'notFound':
    case 'not_found':
      return 'unavailable';
    default:
      return undefined;
  }
}
export function isAgentActive(agent: ClaudeSubagentState): boolean {
  return agent.status === 'started';
}

/** Shared by live protocol events and persisted tool calls. No untrusted path is opened here. */
export class CodexSubagentTracker {
  readonly agents = new Map<string, ClaudeSubagentState>();
  readonly liveItems = new Map<string, Map<string, ClaudeTranscriptItem>>();
  private readonly liveOrder = new Map<
    string,
    { agentId: string; itemId: string; bytes: number }
  >();
  private liveBytes = 0;

  /** Bounded streaming tail across all children; durable history stays in the rollout files. */
  storeItem(agentId: string, item: ClaudeTranscriptItem): void {
    const key = `${agentId}\0${item.id}`;
    const old = this.liveOrder.get(key);
    if (old) {
      this.liveBytes -= old.bytes;
      this.liveOrder.delete(key);
    }
    const content = item.content;
    const bytes =
      256 +
      (content?.length ?? 0) * 2 +
      JSON.stringify(item.providerToolInput ?? item.toolInput ?? null).length *
        2;
    const items =
      this.liveItems.get(agentId) ?? new Map<string, ClaudeTranscriptItem>();
    if (bytes > 16 * 1024 * 1024) {
      items.delete(item.id);
      return;
    }
    const existing = items.get(item.id);
    items.set(item.id, {
      ...item,
      ...(content !== undefined ? { content } : {}),
      timestamp: existing?.timestamp ?? item.timestamp,
    });
    this.liveItems.set(agentId, items);
    this.liveOrder.set(key, { agentId, itemId: item.id, bytes });
    this.liveBytes += bytes;
    while (this.liveBytes > 16 * 1024 * 1024 || this.liveOrder.size > 1200) {
      const oldestKey = this.liveOrder.keys().next().value!;
      const oldest = this.liveOrder.get(oldestKey)!;
      this.liveItems.get(oldest.agentId)?.delete(oldest.itemId);
      this.liveBytes -= oldest.bytes;
      this.liveOrder.delete(oldestKey);
    }
  }

  upsert(
    agentId: string,
    patch: Partial<ClaudeSubagentState>,
    timestamp: string,
  ): ClaudeSubagentState {
    const old = this.agents.get(agentId);
    const next = {
      agentId,
      agentType: 'agent',
      status: 'started' as const,
      startedAt: timestamp,
      ...old,
      ...patch,
      timestamp,
    };
    if (next.executionStatus) {
      next.status = ['pending', 'running', 'waiting'].includes(
        next.executionStatus,
      )
        ? 'started'
        : 'stopped';
      if (next.status === 'stopped')
        next.completedAt = patch.completedAt ?? old?.completedAt ?? timestamp;
      else next.completedAt = undefined;
    }
    this.agents.set(agentId, next);
    return next;
  }

  collaboration(
    raw: RecordValue,
    timestamp: string,
    rootId: string,
  ): ClaudeSubagentState[] {
    const tool = collaborationTool(raw.tool);
    if (!tool) return [];
    const sender = textValue(raw.senderThreadId) ?? rootId;
    const states = record(raw.agentsStates);
    const ids = new Set<string>([
      ...(Array.isArray(raw.receiverThreadIds)
        ? raw.receiverThreadIds.filter(
            (id): id is string => typeof id === 'string' && !!id,
          )
        : []),
      ...Object.keys(states),
    ]);
    const changed: ClaudeSubagentState[] = [];
    for (const id of ids) {
      if (id === rootId || id === sender) continue;
      const old = this.agents.get(id);
      // Only a spawn creates a relationship. Other tools may address existing agents.
      if (!old && tool !== 'spawn_agent') continue;
      const state = record(states[id]);
      const status =
        executionStatus(state.status) ??
        (raw.status !== 'failed' &&
        raw.status !== 'inProgress' &&
        tool === 'close_agent'
          ? 'closed'
          : undefined);
      changed.push(
        this.upsert(
          id,
          {
            ...(tool === 'spawn_agent'
              ? {
                  parentAgentId: sender === rootId ? undefined : sender,
                  parentToolUseId: textValue(raw.id),
                  prompt: readableText(raw.prompt),
                  model: textValue(raw.model),
                  reasoningEffort: textValue(raw.reasoningEffort),
                  ...(!old ? { executionStatus: 'pending' as const } : {}),
                }
              : {}),
            ...(status ? { executionStatus: status } : {}),
            ...(textValue(state.message)
              ? { lastAssistantMessage: textValue(state.message) }
              : {}),
          },
          timestamp,
        ),
      );
    }
    return changed;
  }

  restore(
    history: ClaudeTranscriptItem[],
    rootId: string,
    senderId = rootId,
    aliases: ReadonlyMap<string, string> = new Map(),
  ): void {
    const calls = new Map<string, ClaudeTranscriptItem>();
    for (const item of history) {
      if (item.kind === 'tool_use' && item.toolUseId)
        calls.set(item.toolUseId, item);
      if (item.kind !== 'tool_result' || !item.toolUseId) continue;
      const call = calls.get(item.toolUseId);
      const tool = collaborationTool(call?.providerToolName ?? call?.toolName);
      if (!call || !tool || item.isError) continue;
      const input = record(call.providerToolInput ?? call.toolInput);
      const output = json(item.content);
      if (tool === 'spawn_agent') {
        const taskName = textValue(output.task_name);
        const id =
          textValue(output.agent_id ?? output.agentId) ??
          (taskName ? aliases.get(taskName) : undefined);
        if (!id || id === rootId || id === senderId) continue;
        this.upsert(
          id,
          {
            parentAgentId: senderId === rootId ? undefined : senderId,
            parentToolUseId: call.toolUseId,
            agentPath: taskName,
            prompt: readableText(input.message ?? input.prompt),
            agentType:
              textValue(input.agent_type) ??
              textValue(input.task_name) ??
              textValue(input.subagent_type) ??
              'agent',
            displayName: textValue(output.nickname ?? output.agent_nickname),
            model: textValue(input.model),
            reasoningEffort: textValue(input.reasoning_effort),
            executionStatus: 'pending',
            startedAt: call.timestamp,
          },
          item.timestamp,
        );
      } else {
        const states = record(output.status ?? output.agentsStates);
        for (const [id, rawStatus] of Object.entries(states)) {
          if (!this.agents.has(id)) continue;
          const state = record(rawStatus);
          const status = executionStatus(state.status ?? rawStatus);
          const message = textValue(
            state.message ?? state.completed ?? state.errored,
          );
          this.upsert(
            id,
            {
              ...(status ? { executionStatus: status } : {}),
              ...(message ? { lastAssistantMessage: message } : {}),
            },
            item.timestamp,
          );
        }
        const target = textValue(input.id ?? input.agent_id ?? input.target);
        const id = target ? (aliases.get(target) ?? target) : undefined;
        if (id && this.agents.has(id)) {
          const status =
            tool === 'close_agent'
              ? 'closed'
              : tool === 'interrupt_agent'
                ? 'interrupted'
                : ['send_input', 'followup_task', 'resume_agent'].includes(tool)
                  ? 'running'
                  : undefined;
          if (status)
            this.upsert(id, { executionStatus: status }, item.timestamp);
        }
        if (Array.isArray(output.agents)) {
          for (const value of output.agents) {
            const state = record(value);
            const target = textValue(
              state.agent_id ?? state.id ?? state.task_name ?? state.agent_name,
            );
            const id = target ? (aliases.get(target) ?? target) : undefined;
            if (!id || !this.agents.has(id)) continue;
            const status = executionStatus(state.status ?? state.agent_status);
            this.upsert(
              id,
              {
                ...(status ? { executionStatus: status } : {}),
                ...(textValue(state.nickname)
                  ? { displayName: textValue(state.nickname) }
                  : {}),
              },
              item.timestamp,
            );
          }
        }
      }
    }
  }
}

export function delegatedTaskNames(history: ClaudeTranscriptItem[]): string[] {
  const spawnIds = new Set(
    history
      .filter(
        (item) =>
          item.kind === 'tool_use' &&
          collaborationTool(item.providerToolName ?? item.toolName) ===
            'spawn_agent',
      )
      .map((item) => item.toolUseId),
  );
  return history.flatMap((item) => {
    if (
      item.kind !== 'tool_result' ||
      item.isError ||
      !spawnIds.has(item.toolUseId)
    )
      return [];
    const name = textValue(json(item.content).task_name);
    return name ? [name] : [];
  });
}
