import { agentLabel, agentReferenceLabel, formatAgentTask } from './agent-label';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

export type CollaborationAction =
  | 'spawn'
  | 'message'
  | 'input'
  | 'followup'
  | 'wait'
  | 'list'
  | 'interrupt'
  | 'resume'
  | 'close';
type ExecutionStatus = NonNullable<AgentSubagentState['executionStatus']>;
type JsonRecord = Record<string, unknown>;
const ACTIONS: Record<string, CollaborationAction> = {
  spawnagent: 'spawn',
  sendmessage: 'message',
  sendinput: 'input',
  followuptask: 'followup',
  wait: 'wait',
  waitagent: 'wait',
  listagents: 'list',
  interruptagent: 'interrupt',
  resumeagent: 'resume',
  closeagent: 'close',
};
export const COLLABORATION_LABELS: Record<
  CollaborationAction,
  { label: string; icon: string; progress: string; completed: string }
> = {
  spawn: {
    label: 'Delegate task',
    icon: 'lucideUsers',
    progress: 'Delegating',
    completed: 'Agent spawned',
  },
  message: {
    label: 'Message agent',
    icon: 'lucideSend',
    progress: 'Sending',
    completed: 'Message sent',
  },
  input: {
    label: 'Send input',
    icon: 'lucideMessageSquare',
    progress: 'Sending',
    completed: 'Input sent',
  },
  followup: {
    label: 'Assign follow-up',
    icon: 'lucideCornerDownRight',
    progress: 'Assigning',
    completed: 'Follow-up assigned',
  },
  wait: {
    label: 'Wait for agents',
    icon: 'lucideTimer',
    progress: 'Waiting',
    completed: 'Wait finished',
  },
  list: {
    label: 'Check agents',
    icon: 'lucideListChecks',
    progress: 'Checking',
    completed: 'Agents checked',
  },
  interrupt: {
    label: 'Interrupt agent',
    icon: 'lucidePause',
    progress: 'Interrupting',
    completed: 'Agent interrupted',
  },
  resume: {
    label: 'Resume agent',
    icon: 'lucidePlay',
    progress: 'Resuming',
    completed: 'Agent resumed',
  },
  close: {
    label: 'Close agent',
    icon: 'lucideCircleX',
    progress: 'Closing',
    completed: 'Agent closed',
  },
};
export function collaborationRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
export function readableCollaborationText(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /^gAAAAA[A-Za-z0-9_-]{100,}={0,2}$/.test(value.trim())
  )
    return undefined;
  return value.trim();
}
function plainText(value: unknown): string | undefined {
  if (typeof value === 'string') return readableCollaborationText(value);
  if (Array.isArray(value))
    return readableCollaborationText(
      value
        .map((part) =>
          typeof part === 'string' ? part : (collaborationRecord(part)['text'] ?? ''),
        )
        .filter((text) => typeof text === 'string')
        .join('\n'),
    );
  const object = collaborationRecord(value);
  return readableCollaborationText(object['text']);
}
function receiptRecord(value: unknown, depth = 0): JsonRecord {
  if (depth > 3) return {};
  if (typeof value === 'string') {
    try {
      return receiptRecord(JSON.parse(value), depth + 1);
    } catch {
      return {};
    }
  }
  if (Array.isArray(value)) {
    if (
      value.length &&
      value.every((entry) => {
        const agent = collaborationRecord(entry);
        return (
          agent['agent_id'] ||
          agent['agent_name'] ||
          agent['task_name'] ||
          agent['threadId'] ||
          (agent['id'] && agent['agent_status'])
        );
      })
    )
      return { agents: value };
    return receiptRecord(plainText(value), depth + 1);
  }
  const object = collaborationRecord(value);
  if (Array.isArray(object['content'])) return receiptRecord(object['content'], depth + 1);
  return object;
}
const RECEIPT_CACHE_BYTES = 2 * 1024 * 1024;
const receiptCache = new Map<string, { value: JsonRecord; bytes: number }>();
let receiptCacheBytes = 0;
/** Live status changes must not reparse the same historical roster on every card. */
function cachedReceipt(value: unknown): JsonRecord {
  if (typeof value !== 'string' || value.length > 262_144) return receiptRecord(value);
  const cached = receiptCache.get(value);
  if (cached) {
    receiptCache.delete(value);
    receiptCache.set(value, cached);
    return cached.value;
  }
  const parsed = receiptRecord(value);
  const bytes = value.length * 2;
  receiptCache.set(value, { value: parsed, bytes });
  receiptCacheBytes += bytes;
  while (receiptCacheBytes > RECEIPT_CACHE_BYTES || receiptCache.size > 128) {
    const oldest = receiptCache.keys().next().value!;
    receiptCacheBytes -= receiptCache.get(oldest)!.bytes;
    receiptCache.delete(oldest);
  }
  return parsed;
}
export function collaborationAction(
  call: Pick<
    AgentTranscriptItem,
    'toolName' | 'providerToolName' | 'toolInput' | 'providerToolInput'
  >,
): CollaborationAction | null {
  const name = call.providerToolName ?? call.toolName ?? '';
  if (name === 'SendMessage') return null; // Claude team housekeeping retains its existing treatment.
  const input = collaborationRecord(call.providerToolInput ?? call.toolInput);
  if (name.toLowerCase().startsWith('mcp') || typeof input['server'] === 'string') return null;
  const normalized = name
    .split('.')
    .at(-1)!
    .replace(/[_\-\s]/g, '')
    .toLowerCase();
  if (normalized === 'wait' && input['cell_id'] !== undefined) return null;
  return Object.hasOwn(ACTIONS, normalized) ? ACTIONS[normalized] : null;
}
export function collaborationStatus(value: unknown): ExecutionStatus | undefined {
  const raw = typeof value === 'string' ? value : Object.keys(collaborationRecord(value))[0];
  switch (raw) {
    case 'pendingInit':
    case 'pending_init':
    case 'pending':
      return 'pending';
    case 'running':
    case 'active':
    case 'inProgress':
      return 'running';
    case 'waiting':
    case 'requires_action':
      return 'waiting';
    case 'completed':
    case 'idle':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    case 'error':
    case 'errored':
    case 'failed':
      return 'error';
    case 'closed':
    case 'shutdown':
      return 'closed';
    case 'unavailable':
    case 'notFound':
    case 'not_found':
      return 'unavailable';
    default:
      return undefined;
  }
}
export function buildSubagentIndex(
  agents: Iterable<AgentSubagentState>,
): ReadonlyMap<string, AgentSubagentState> {
  const index = new Map<string, AgentSubagentState>();
  const aliases = new Map<string, AgentSubagentState | null>();
  for (const agent of agents) {
    index.set(agent.agentId, agent);
    if (agent.agentPath) {
      index.set(agent.agentPath, agent);
      const leaf = agent.agentPath.split('/').at(-1)!;
      aliases.set(leaf, aliases.has(leaf) ? null : agent);
    }
    if (agent.parentToolUseId) index.set(`tool:${agent.parentToolUseId}`, agent);
  }
  for (const [alias, agent] of aliases) if (agent && !index.has(alias)) index.set(alias, agent);
  return index;
}
export interface CollaborationAgentRow {
  key: string;
  reference: string;
  agentId?: string;
  label: string;
  nickname?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  path?: string;
  response?: string;
  status?: Pick<AgentSubagentState, 'status' | 'executionStatus'>;
  currentStatus?: Pick<AgentSubagentState, 'status' | 'executionStatus'>;
}
export interface CollaborationView {
  action: CollaborationAction;
  label: string;
  icon: string;
  outcome: string;
  tone: 'success' | 'warning' | 'destructive' | 'muted';
  payload?: string;
  payloadLabel: string;
  payloadUnavailable: boolean;
  error?: string;
  receiptText?: string;
  sender?: string;
  rows: CollaborationAgentRow[];
  metadata: string[];
}
function statusView(state: ExecutionStatus | undefined): CollaborationAgentRow['status'] {
  return state
    ? {
        status: ['pending', 'running', 'waiting'].includes(state) ? 'started' : 'stopped',
        executionStatus: state,
      }
    : undefined;
}
export function collaborationView(
  call: AgentTranscriptItem,
  result: AgentTranscriptItem | null,
  agents: ReadonlyMap<string, AgentSubagentState> = new Map(),
  isLive = false,
): CollaborationView | null {
  const action = collaborationAction(call);
  if (!action) return null;
  const input = collaborationRecord(call.providerToolInput ?? call.toolInput);
  const output = cachedReceipt(result?.content);
  const rows = new Map<string, CollaborationAgentRow>();
  const snapshot = action === 'wait' || action === 'list';
  const addRow = (reference: unknown, data: JsonRecord = {}, state?: unknown) => {
    if (typeof reference !== 'string' || !reference.trim()) return;
    const agent = agents.get(reference);
    const key = agent?.agentId ?? reference;
    const old = rows.get(key);
    const reported = collaborationStatus(data['status'] ?? data['agent_status'] ?? state);
    const resolvedState = snapshot
      ? (reported ?? agent?.executionStatus)
      : (agent?.executionStatus ?? reported);
    const currentState =
      snapshot &&
      reported &&
      agent?.executionStatus &&
      reported !== agent.executionStatus &&
      result &&
      agent.timestamp > result.timestamp
        ? agent.executionStatus
        : undefined;
    const stateRecord = collaborationRecord(state);
    const response = readableCollaborationText(
      data['message'] ??
        stateRecord['message'] ??
        stateRecord['completed'] ??
        stateRecord['errored'],
    );
    const path =
      agent?.agentPath ??
      readableCollaborationText(
        data['task_name'] ?? data['agent_name'] ?? data['canonical_name'],
      ) ??
      (action === 'spawn' ? readableCollaborationText(input['task_name']) : undefined) ??
      (reference.startsWith('/') ? reference : undefined) ??
      old?.path;
    const role =
      agent?.agentType ??
      readableCollaborationText(data['agent_type'] ?? data['agent_role']) ??
      old?.role;
    rows.set(key, {
      ...old,
      key,
      reference,
      agentId: agent?.agentId,
      label: path
        ? agentReferenceLabel(path)
        : role
          ? formatAgentTask(role)
          : (old?.label ?? agentReferenceLabel(reference)),
      nickname:
        agent?.displayName ??
        readableCollaborationText(data['nickname'] ?? data['agent_nickname']) ??
        old?.nickname,
      role: role ? formatAgentTask(role) : undefined,
      model: agent?.model ?? readableCollaborationText(data['model']) ?? old?.model,
      reasoningEffort:
        agent?.reasoningEffort ??
        readableCollaborationText(data['reasoning_effort'] ?? data['reasoningEffort']) ??
        old?.reasoningEffort,
      path,
      ...(response ? { response } : {}),
      ...(resolvedState ? { status: statusView(resolvedState) } : {}),
      ...(currentState ? { currentStatus: statusView(currentState) } : {}),
    });
  };
  for (const value of [input['target'], input['id'], input['agent_id'], input['recipient']])
    addRow(value);
  for (const values of [input['ids'], input['agent_ids'], input['receiverThreadIds']])
    if (Array.isArray(values)) values.forEach((value) => addRow(value));
  if (action === 'spawn') {
    addRow(output['agent_id'] ?? output['agentId'] ?? output['task_name'], output);
    if (!rows.size) {
      const agent = agents.get(`tool:${call.toolUseId ?? call.id}`);
      if (agent) addRow(agent.agentId);
    }
  }
  if (Array.isArray(output['agents']))
    for (const value of output['agents']) {
      const row = collaborationRecord(value);
      addRow(
        row['agent_id'] ??
          row['id'] ??
          row['threadId'] ??
          row['task_name'] ??
          row['agent_name'] ??
          row['canonical_name'],
        row,
      );
    }
  for (const [reference, value] of Object.entries(
    collaborationRecord(output['agentsStates'] ?? output['status']),
  ))
    addRow(reference, collaborationRecord(value), value);
  const rawError = output['error'];
  const isError =
    !!result?.isError || output['success'] === false || output['status'] === 'failed' || !!rawError;
  const error = isError
    ? (readableCollaborationText(collaborationRecord(rawError)['message'] ?? rawError) ??
      (typeof result?.content === 'string' && !Object.keys(output).length
        ? readableCollaborationText(result.content.replace(/<\/?tool_use_error>/g, ''))
        : undefined) ??
      'This agent action failed.')
    : undefined;
  const timedOut = output['timed_out'] === true || output['timedOut'] === true;
  const labels = COLLABORATION_LABELS[action];
  let outcome = isError
    ? 'Failed'
    : !result
      ? isLive
        ? labels.progress
        : 'No result recorded'
      : timedOut
        ? 'Wait timed out'
        : labels.completed;
  let tone: CollaborationView['tone'] = isError
    ? 'destructive'
    : timedOut
      ? 'warning'
      : !result
        ? 'muted'
        : action === 'interrupt'
          ? 'warning'
          : 'success';
  if (action === 'list' && result && !isError) {
    const active = [...rows.values()].filter((row) => row.status?.status === 'started').length;
    const attention = [...rows.values()].filter((row) =>
      ['error', 'interrupted', 'unavailable'].includes(row.status?.executionStatus ?? ''),
    ).length;
    outcome = `${rows.size} agent${rows.size === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}${attention ? ` · ${attention} need attention` : ''}`;
    if (attention) tone = 'warning';
  }
  const payload = plainText(input['message'] ?? input['prompt']);
  const receiptText =
    readableCollaborationText(output['summary'] ?? output['message'] ?? output['result']) ??
    (!Object.keys(output).length &&
    typeof result?.content === 'string' &&
    !/^[\s]*[\[{]/.test(result.content)
      ? readableCollaborationText(result.content)
      : undefined);
  const metadata: string[] = [];
  const model = readableCollaborationText(input['model']);
  const effort = readableCollaborationText(input['reasoning_effort'] ?? input['reasoningEffort']);
  if (model) metadata.push(model);
  if (effort) metadata.push(`${effort} reasoning`);
  const fork = input['fork_turns'];
  if (fork === 'all') metadata.push('Full conversation context');
  else if (fork === 'none') metadata.push('Fresh context');
  else if (typeof fork === 'number' || (typeof fork === 'string' && /^\d+$/.test(fork)))
    metadata.push(`Last ${fork} turn${Number(fork) === 1 ? '' : 's'}`);
  const timeout = input['timeout_ms'];
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0)
    metadata.push(
      `Timeout ${timeout >= 60_000 ? `${Math.round(timeout / 60_000)}m` : `${Math.round(timeout / 1000)}s`}`,
    );
  if (input['interrupt'] === true) metadata.push('Interruption requested');
  const sender =
    typeof input['senderThreadId'] === 'string' ? agents.get(input['senderThreadId']) : undefined;
  return {
    action,
    label: labels.label,
    icon: labels.icon,
    outcome,
    tone,
    error,
    receiptText,
    payload,
    payloadLabel: action === 'message' || action === 'input' ? 'Message' : 'Assignment',
    payloadUnavailable: !payload && ['spawn', 'message', 'input', 'followup'].includes(action),
    sender: sender ? agentLabel(sender) : undefined,
    rows: [...rows.values()],
    metadata,
  };
}
