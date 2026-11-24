import type {
  DelegatedSessionWork, SessionAgentContext, SessionAgentOperationResult, SessionAgentReference,
  SessionAgentSelection, SessionAgentSender, SessionAgentStatus, SessionAgentTurnEntry, SessionChildSummary,
} from '@elevenex/shared';
import { parseChangeSummary } from './session-chat-changes';
import { chatObject, chatText, invalid } from './session-chat-values';

function enumeration<T extends string>(value: unknown, options: readonly T[]): T {
  const match = options.find(option => option === value);
  if (match === undefined) throw invalid();
  return match;
}
function optional<T>(record: Record<string, unknown>, key: string, parse: (value: unknown) => T): T | undefined {
  return record[key] === undefined ? undefined : parse(record[key]);
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw invalid();
  return value;
}
function identity(value: unknown): number { return integer(value, 1); }
function time(value: unknown): string {
  const at = chatText(value, 100);
  if (!Number.isFinite(Date.parse(at))) throw invalid();
  return at;
}
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(parse);
}
function unique<T>(values: readonly T[]): readonly T[] {
  if (new Set(values).size !== values.length) throw invalid();
  return values;
}
function status(value: unknown): SessionAgentStatus {
  return enumeration(value, ['pending', 'running', 'waiting', 'paused', 'completed', 'stopped', 'error', 'unavailable']);
}
function requiredText(value: unknown, max = 1000): string {
  const result = chatText(value, max);
  if (!result.trim()) throw invalid();
  return result;
}
function trueValue(value: unknown): true {
  if (value !== true) throw invalid();
  return true;
}
function messageId(value: unknown): string {
  const id = chatText(value, 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid();
  return id;
}

export function parseAgentSelection(value: unknown): SessionAgentSelection {
  const row = chatObject(value);
  return {
    provider: requiredText(row['provider'], 80),
    model: optional(row, 'model', value => chatText(value, 160)),
    effort: optional(row, 'effort', value => chatText(value, 80)),
  };
}

export function parseAgentReference(value: unknown): SessionAgentReference {
  const row = chatObject(value);
  return {
    sessionId: identity(row['sessionId']),
    taskId: optional(row, 'taskId', identity),
    title: optional(row, 'title', value => chatText(value, 300)),
    selection: optional(row, 'selection', parseAgentSelection),
  };
}

export function parseAgentSender(value: unknown): SessionAgentSender {
  const row = chatObject(value);
  return {
    session: parseAgentReference(row['session']),
    purpose: enumeration(row['purpose'], ['assignment', 'message']),
    messageId: optional(row, 'messageId', messageId),
  };
}

export function parseAgentContext(value: unknown, sessionId: number | undefined, taskId: number | undefined): SessionAgentContext {
  const row = chatObject(value);
  const parent = optional(row, 'parent', parseAgentReference);
  const parentWaiting = optional(row, 'parentWaiting', trueValue);
  const returns = optional(row, 'returns', items => list(items, 12, item => {
    const receipt = chatObject(item);
    const recipient = parseAgentReference(receipt['recipient']);
    if (recipient.sessionId === sessionId) throw invalid();
    return { itemId: requiredText(receipt['itemId']), recipient, at: time(receipt['at']) };
  }));
  if ((parent && (parent.sessionId === sessionId || (taskId !== undefined && parent.taskId !== taskId))) ||
      (parentWaiting && !parent)) throw invalid();
  return { parent, parentWaiting, returns, selection: optional(row, 'selection', parseAgentSelection) };
}

export function parseDelegatedWork(value: unknown, sessionId: number | undefined, taskId: number | undefined): readonly DelegatedSessionWork[] {
  const rows = list(value, 28, (item): DelegatedSessionWork => {
    const row = chatObject(item);
    const session = parseAgentReference(row['session']);
    if (session.sessionId === sessionId || (taskId !== undefined && session.taskId !== taskId)) throw invalid();
    return {
      session, status: status(row['status']), detail: chatText(row['detail'], 300),
      startedAt: row['startedAt'] === null ? null : time(row['startedAt']),
      endedAt: row['endedAt'] === null ? null : time(row['endedAt']),
      toolUses: optional(row, 'toolUses', integer),
      tokens: optional(row, 'tokens', integer),
      delivered: optional(row, 'delivered', entries => unique(list(entries, 8, messageId))),
    };
  });
  unique(rows.map(row => row.session.sessionId));
  const live = rows.filter(row => ['pending', 'running', 'waiting', 'paused'].includes(row.status)).length;
  if (live > 16 || rows.length - live > 12) throw invalid();
  return rows;
}

function outcome(value: unknown, replyAllowed: boolean): SessionAgentOperationResult {
  const row = chatObject(value);
  const reply = optional(row, 'reply', value => {
    const data = chatObject(value);
    if (!replyAllowed || typeof data['truncated'] !== 'boolean') throw invalid();
    return {
      id: requiredText(data['id']), text: requiredText(data['text'], 8000), truncated: data['truncated'],
      changes: optional(data, 'changes', value => parseChangeSummary(value, 3)),
    };
  });
  return {
    session: optional(row, 'session', parseAgentReference),
    agentId: optional(row, 'agentId', value => requiredText(value, 256)),
    status: optional(row, 'status', status),
    delivery: optional(row, 'delivery', (value): NonNullable<SessionAgentOperationResult['delivery']> =>
      enumeration(value, ['queued', 'accepted', 'unconfirmed'])),
    messageId: optional(row, 'messageId', messageId),
    event: optional(row, 'event', value => chatText(value, 80)),
    detail: optional(row, 'detail', value => chatText(value, 360)),
    agents: optional(row, 'agents', value => list(value, 16, agent => {
      const info = chatObject(agent);
      return { agentId: requiredText(info['agentId'], 256), status: status(info['status']),
        detail: optional(info, 'detail', value => chatText(value, 360)) };
    })),
    reply,
  };
}

export function parseAgentEntry(value: unknown, replyAllowed: boolean, callId?: string): SessionAgentTurnEntry {
  const row = chatObject(value), operation = chatObject(row['operation']), id = requiredText(row['id']);
  if (callId !== undefined && id !== callId) throw invalid();
  const type: SessionAgentTurnEntry['operation']['type'] =
    enumeration(operation['type'], ['launch', 'message', 'wait', 'stop', 'read', 'search', 'catalog', 'native', 'native-wait']);
  const result = optional(row, 'result', value => outcome(value, replyAllowed && type === 'wait'));
  return {
    id, toolId: optional(row, 'toolId', requiredText), at: time(row['at']),
    endedAt: optional(row, 'endedAt', time), failed: optional(row, 'failed', trueValue),
    operation: {
      type, sessions: optional(operation, 'sessions', value => unique(list(value, 16, identity))),
      agents: optional(operation, 'agents', value => unique(list(value, 16, agent => requiredText(agent, 256)))),
      title: optional(operation, 'title', value => chatText(value, 300)),
      identity: optional(operation, 'identity', parseAgentSelection),
      message: optional(operation, 'message', value => chatText(value, 400)),
      requestId: optional(operation, 'requestId', value => chatText(value, 128)),
    },
    result,
  };
}

export function parseChildSummary(value: unknown): SessionChildSummary {
  const row = chatObject(value);
  return {
    status: enumeration(row['status'], ['attention', 'failed', 'running', 'done']),
    count: integer(row['count'], 1),
  };
}
