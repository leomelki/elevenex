import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
function readable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    try {
      return readable(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value))
    return value
      .map((part) => (typeof part === 'string' ? part : text(record(part)['text'])))
      .filter(Boolean)
      .join('\n');
  const data = record(value);
  return (
    text(data['result']) ||
    text(data['text']) ||
    text(data['message']) ||
    (data['content'] === undefined ? '' : readable(data['content']))
  );
}

export function claudeDelegationTool(
  call: Pick<
    AgentTranscriptItem,
    'toolName' | 'providerToolName' | 'toolInput' | 'providerToolInput'
  >,
): string | null {
  const name = call.providerToolName ?? call.toolName;
  if (record(call.providerToolInput ?? call.toolInput)['server']) return null;
  return name && ['Agent', 'Task', 'SendMessage', 'TaskStop', 'TaskOutput'].includes(name)
    ? name
    : null;
}

export function claudeDelegationView(
  call: AgentTranscriptItem,
  result: AgentTranscriptItem | null,
  agents: ReadonlyMap<string, AgentSubagentState> = new Map(),
) {
  const tool = claudeDelegationTool(call);
  const input = record(call.providerToolInput ?? call.toolInput);
  const nested = record(input['message']);
  let output = result?.providerToolResult;
  if (!output && result?.content) {
    try {
      output = JSON.parse(result.content);
    } catch {
      /* Plain reports are normal. */
    }
  }
  const data = record(output);
  const rawReport =
    readable(data['content']) ||
    readable(data['result']) ||
    readable(data['message']) ||
    readable(result?.content);
  const id =
    text(data['agentId']) ||
    text(data['agent_id']) ||
    text(input['task_id']) ||
    text(input['to']) ||
    text(input['recipient']) ||
    text(nested['recipient']) ||
    rawReport.match(/agentId:\s*([\w-]+)/)?.[1];
  const agent = id
    ? agents.get(id)
    : [...agents.values()].find((item) => item.parentToolUseId === call.toolUseId);
  const asyncLaunch =
    data['isAsync'] === true ||
    data['status'] === 'async_launched' ||
    /async agent launched|agent is working in the background/i.test(rawReport);
  const report = asyncLaunch
    ? agent?.status === 'stopped'
      ? (agent.lastAssistantMessage ?? '')
      : ''
    : rawReport;
  const messageType = text(nested['type']) || text(input['type']);
  const title =
    tool === 'Agent' || tool === 'Task'
      ? text(input['description']) || 'Delegate task'
      : tool === 'TaskStop'
        ? 'Stop task'
        : tool === 'TaskOutput'
          ? 'Wait for result'
          : messageType === 'shutdown_request'
            ? 'Request shutdown'
            : messageType === 'plan_approval_response'
              ? 'Respond to plan'
              : 'Message agent';
  return {
    tool,
    title,
    agent,
    reference: agent?.agentId ?? id,
    label: agent?.displayName || agent?.agentType || id || text(input['subagent_type']) || 'Agent',
    prompt: text(input['prompt']),
    message: text(input['content']) || text(input['message']) || text(nested['content']),
    report: report
      .replace(/<usage>[\s\S]*?<\/usage>\s*$/i, '')
      .replace(/\n*agentId:[^\n]*(?:\n(?:worktreePath|worktreeBranch):[^\n]*)*\s*$/i, '')
      .trim(),
    error: Boolean(result?.isError || data['error']),
    background:
      agent?.isBackgrounded ?? (input['run_in_background'] === true || data['isAsync'] === true),
    model: agent?.model || text(input['model']),
    icon:
      tool === 'TaskStop'
        ? 'lucideSquare'
        : tool === 'TaskOutput'
          ? 'lucideTimer'
          : tool === 'SendMessage'
            ? 'lucideSend'
            : 'lucideBot',
  };
}
