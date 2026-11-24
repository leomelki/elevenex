import type {
  SessionAgentOperation, SessionAgentOperationResult, SessionAgentReference, SessionAgentSelection,
  SessionAgentStatus, SessionAgentTurnEntry,
  SessionChatChangedFile,
} from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItemFailed, record } from './desktop-chat-tool-outcome.js';

const tools: Readonly<Record<string, SessionAgentOperation['type']>> = {
  create_session: 'launch',
  prompt_session: 'message',
  await_session_event: 'wait',
  interrupt_session: 'stop',
  read_session: 'read',
  read_session_range: 'read',
  grep_session: 'search',
  list_agent_harnesses: 'catalog',
};

function decode(value: unknown): unknown {
  // The tool's structured result is preferred. Claude may keep only its text mirror.
  if (typeof value !== 'string' || value.length > 512_000 || !/^\s*[{[]/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
function line(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.trimStart().slice(0, limit * 2).replace(/\s+/g, ' ').slice(0, limit).trimEnd() || undefined : undefined;
}
function id(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function selection(source: Record<string, unknown>): SessionAgentSelection | undefined {
  const provider = line(source.provider, 80);
  return provider ? { provider, model: line(source.model, 160), effort: line(source.effort ?? source.reasoningEffort, 80) } : undefined;
}
function reference(data: Record<string, unknown>, fallback?: number): SessionAgentReference | undefined {
  const src = record(data.session);
  const sessionId = id(src.sessionId ?? data.sessionId) ?? fallback;
  return sessionId ? {
    sessionId, taskId: id(src.taskId ?? data.taskId), title: line(src.title ?? data.name, 300),
    selection: selection(Object.keys(src).length ? record(src.selection) : data),
  } : undefined;
}

function operation(call: AgentTranscriptItem): SessionAgentOperation | undefined {
  const name = call.providerToolName ?? call.toolName ?? '';
  const prefix = /^(?:mcp__elevenex__|elevenex_)(.+)$/.exec(name);
  if (!prefix && call.toolKind !== 'mcp' && call.toolKind !== 'task_agent' && call.toolKind !== 'agent_collaboration') return;
  const input = record(decode(call.toolInput ?? call.providerToolInput));
  if (call.toolKind === 'agent_collaboration' && /(?:^|[.])wait(?:_agent)?$/.test(name)) {
    const ids: unknown = input.receiverThreadIds ?? input.ids ?? input.targets;
    return { type: 'native-wait', agents: [...new Set((Array.isArray(ids) ? ids.slice(0, 16) : []).flatMap(
      value => line(value, 256) ?? [],
    ))] };
  }
  if (call.toolKind === 'task_agent' || (call.toolKind === 'agent_collaboration' && /(?:^|[.])spawn_agent$/.test(name)))
    return {
      type: 'native',
      title: line(input.description ?? input.task_name ?? input.name ?? input.prompt, 300),
      message: line(input.subagent_type ?? input.agent_type, 80),
    };

  const tool = prefix?.[1] ?? (input.server === 'elevenex' ? (line(input.tool, 80) ?? name) : undefined);
  if (!tool || !Object.hasOwn(tools, tool)) return;
  const type = tools[tool];
  const args = record(input.arguments ?? input);
  const targets: readonly unknown[] = Array.isArray(args.sessionIds) ? args.sessionIds.slice(0, 16) : [args.sessionId];
  const sessions = [...new Set(targets.flatMap(value => id(value) ?? []))];
  return {
    type,
    ...(sessions.length ? { sessions } : {}),
    ...(type === 'launch' ? {
      title: line(args.name ?? (typeof args.prompt === 'string' ? args.prompt.split(/\r?\n/, 1)[0] : undefined), 300),
      requestId: line(args.requestId, 128),
      identity: selection(args),
    } : {}),
    ...(type === 'message' ? { message: line(args.prompt, 400) } : {}),
  };
}

function envelope(result: AgentTranscriptItem): Record<string, unknown> {
  for (const value of [result.providerToolResult, result.content]) {
    const decoded = decode(value);
    const raw = record(decoded);
    const structured = record(raw.structuredContent ?? raw.structured_content);
    if (structured.data || structured.error) return structured;
    if (raw.data || raw.error) return raw;
    const content = Array.isArray(decoded) ? decoded : Array.isArray(raw.content) ? raw.content : [];
    for (const block of content.slice(0, 4)) {
      const payload = record(decode(record(block).text));
      if (payload.data || payload.error) return payload;
    }
  }
  return {};
}
function status(value: unknown): SessionAgentStatus | undefined {
  switch (value) {
    case 'requires_action': return 'waiting';
    case 'queued':
    case 'not_started':
    case 'acceptance_pending':
    case 'created': return 'pending';
    case 'accepted':
    case 'active':
    case 'running': return 'running';
    case 'failed': return 'error';
    case 'paused':
    case 'completed':
    case 'stopped': return value;
    case 'archived': return 'unavailable';
  }
}

function resultFor(op: SessionAgentOperation, row: AgentTranscriptItem, includeReply: boolean): SessionAgentOperationResult {
  if (op.type === 'native' || op.type === 'native-wait') {
    const native = { ...record(decode(row.content)), ...record(row.providerToolResult) };
    const states = record(native.agentsStates ?? native.status);
    const agents = Object.entries(states).slice(0, 16).flatMap(([agentId, value]) => {
      const state = record(value);
      const phase = state.status ?? (state.completed ? 'completed' : state.errored ? 'failed' : value);
      const outcome = status(phase) ?? (phase === 'errored' ? 'error' : phase === 'interrupted' || phase === 'shutdown' ? 'stopped' : undefined);
      return agentId.length <= 256 && outcome ? [{ agentId, status: outcome, detail: line(state.message ?? state.completed ?? state.errored, 360) }] : [];
    });
    if (op.type === 'native-wait') return { ...(agents.length ? { agents } : {}) };
    const text = typeof row.content === 'string' ? row.content : '';
    const agentId = line(native.agentId ?? native.agent_id ?? /\bagentId:\s*([\w-]+)/.exec(text)?.[1], 256);
    const async = native.isAsync === true || native.status === 'async_launched' || /async agent launched|agent is working in the background/i.test(text);
    const spawned = typeof native.agent_id === 'string';
    const observed = agents.find(agent => agent.agentId === agentId);
    return {
      agentId,
      status: row.isError ? 'error' : observed?.status ?? (async || spawned ? 'running' : 'completed'),
      detail: observed?.detail ?? (async || spawned ? undefined : line(text.replace(/<usage>[\s\S]*$/i, '').replace(/\bagentId:[^\n]*$/im, ''), 360)),
    };
  }
  const payload = envelope(row);
  const data = record(payload.data), error = record(payload.error);
  const event = line(data.event, 80);
  const reply = record(data.reply);
  const replyId = line(reply.id, 1000);
  const replyText = typeof reply.text === 'string' ? reply.text.trim() : '';
  const changes = record(reply.changes);
  const files = (Array.isArray(changes.files) ? changes.files.slice(0, 3) : []).flatMap((value): SessionChatChangedFile[] => {
    const file = record(value);
    const path = typeof file.path === 'string' && file.path.length <= 1000 ? file.path : '';
    const stat = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    return path ? [{ path, add: stat(file.add), del: stat(file.del), status: file.status === 'A' || file.status === 'D' ? file.status : 'M' }] : [];
  });
  const session = reference(data, id(record(error.details).sessionId) ?? (op.sessions?.length === 1 ? op.sessions[0] : undefined));
  const deliveryStatus = data.promptStatus ?? data.status;
  const returnedTurns = data.returnedTurns ?? data.newTurns;
  const matches = Array.isArray(data.matches) ? data.matches.length : undefined;
  const catalog = Array.isArray(data.harnesses) ? data.harnesses.length : Array.isArray(data.models) ? data.models.length : undefined;
  const detail = line(error.message ?? (row.isError ? row.content : undefined), 360) ??
    (op.type === 'launch' && deliveryStatus === 'created' ? 'Ready for an assignment' :
      op.type === 'read' && typeof returnedTurns === 'number' ? returnedTurns + (returnedTurns === 1 ? ' turn' : ' turns') :
      op.type === 'search' && matches !== undefined ? matches + (matches === 1 ? ' match' : ' matches') :
      op.type === 'catalog' && catalog !== undefined ? catalog + (Array.isArray(data.models) ? ' models' : ' harnesses') : undefined);
  return {
    session, event, messageId: typeof data.messageId === 'string' && /^[a-f0-9-]{36}$/.test(data.messageId) ? data.messageId : undefined,
    status: row.isError ? 'error' : op.type === 'stop' && data.interrupted === true ? 'stopped'
      : status(deliveryStatus) ?? (op.type === 'launch' && session ? 'pending' : undefined),
    ...(deliveryStatus === 'acceptance_pending' ? { delivery: 'unconfirmed' as const } :
      deliveryStatus === 'queued' || data.queued === true ? { delivery: 'queued' as const } :
      data.accepted === true ? { delivery: 'accepted' as const } : {}),
    detail: detail ?? (replyText && !includeReply ? line(replyText, 360) : undefined),
    ...(op.type === 'wait' && includeReply && session && replyId && replyText ? {
      reply: {
        id: replyId, text: replyText.slice(0, 8000), truncated: reply.truncated === true || replyText.length > 8000,
        ...(files.length ? { changes: { files: [...new Map(files.map(file => [file.path, file])).values()],
          total: Math.max(files.length, id(changes.total) ?? 0), ...(changes.shared === true ? { shared: true as const } : {}) } } : {}),
      },
    } : {}),
  };
}

/** The call owns the lifecycle. The returned Markdown stays on its receipt in source order. */
export function chatAgentEntry(raw: AgentTranscriptItem, peer?: AgentTranscriptItem): SessionAgentTurnEntry | undefined {
  const call = raw.kind === 'tool_use' ? raw : raw.kind === 'tool_result' ? peer : undefined;
  if (!call || call.kind !== 'tool_use' || !call.id || call.id.length > 1000 ||
      !Number.isFinite(Date.parse(call.timestamp))) return;
  const op = operation(call);
  if (!op) return;
  const result = raw.kind === 'tool_result' ? raw : peer;
  const failed = chatItemFailed(call) || (result && chatItemFailed(result));
  return {
    id: call.id, toolId: call.toolUseId && call.toolUseId.length <= 1000 ? call.toolUseId : undefined, at: call.timestamp,
    operation: op,
    ...(result ? { endedAt: Number.isFinite(Date.parse(result.timestamp)) ? result.timestamp : call.timestamp,
      result: resultFor(op, result, raw.kind === 'tool_result') } : {}),
    ...(failed ? { failed: true as const } : {}),
  };
}
