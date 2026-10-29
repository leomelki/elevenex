import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function display(value: unknown, limit = 16000): string {
  const text =
    typeof value === 'string'
      ? value
      : value == null
        ? ''
        : JSON.stringify(value, null, 2);
  const suffix = '\n… [display shortened]';
  return text.length > limit
    ? text.slice(0, Math.max(0, limit - suffix.length)) + suffix
    : text;
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nullable = (value: unknown) =>
  typeof value === 'string' ? display(value, 1000) : null;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
export function chatItem(item: AgentTranscriptItem) {
  const input = display(item.toolInput);
  const text = display(
    item.content ?? item.providerToolResult ?? item.agentMessage?.body ?? '',
  );
  return {
    id: item.id,
    kind: item.kind,
    text,
    timestamp: item.timestamp,
    toolId: item.toolUseId ?? null,
    toolName:
      item.toolDisplayName ?? item.providerToolName ?? item.toolName ?? null,
    toolKind: item.toolKind ?? null,
    input,
    error: item.isError === true,
    truncated:
      text.endsWith('… [display shortened]') ||
      input.endsWith('… [display shortened]'),
  };
}
export function chatState(
  raw: Record<string, unknown>,
  provider: string,
  permissionModes: readonly string[],
) {
  const permission = record(raw.pendingPermissionRequest),
    usage = record(raw.contextUsage);
  const permissionQuestion =
    permission.toolKind === 'ask_user_question' ||
    String(permission.toolName).toLowerCase() === 'askuserquestion';
  const question = permissionQuestion
    ? {
        ...permission,
        ...record(permission.input),
        message: permission.description ?? '',
      }
    : record(raw.pendingUserInputRequest);
  const questions = list(question.questions)
    .slice(0, 20)
    .map((value, index) => {
      const q = record(value);
      return {
        id: display(q.id ?? q.question ?? index, 1000),
        question: display(q.question, 4000),
        multiple: q.multiSelect === true,
        options: list(q.options)
          .slice(0, 30)
          .map((value) => {
            const option = record(value);
            return {
              label: display(option.label, 1000),
              detail: display(option.description, 2000),
            };
          }),
      };
    });
  if (!questions.length) {
    for (const [id, value] of Object.entries(
      record(record(question.requestedSchema).properties),
    ).slice(0, 20)) {
      const field = record(value);
      const choices =
        field.type === 'boolean' ? ['true', 'false'] : list(field.enum);
      questions.push({
        id,
        question: display(field.title ?? field.description ?? id, 4000),
        multiple: false,
        options: choices
          .slice(0, 30)
          .map((value) => ({ label: display(value, 1000), detail: '' })),
      });
    }
  }
  const activity = ['subagents', 'tasks', 'notifications', 'hooks'].flatMap(
    (key) =>
      list(raw[key])
        .slice(-12)
        .map((value, index) => {
          const item = record(value);
          return {
            id: display(
              item.id ?? item.agentId ?? item.taskId ?? `${key}-${index}`,
              1000,
            ),
            label: display(
              item.description ??
                item.displayName ??
                item.title ??
                item.subject ??
                item.text ??
                item.message ??
                item.name ??
                key,
              2000,
            ),
            detail: display(
              item.executionStatus ?? item.status ?? item.state ?? item.summary,
              2000,
            ),
          };
        }),
  );
  for (const key of [
    'rateLimit',
    'latestApiRetry',
    'latestToolProgress',
    'latestCompactBoundary',
    'latestMirrorError',
  ]) {
    if (raw[key])
      activity.push({
        id: key,
        label:
          key === 'latestApiRetry'
            ? 'Retrying request'
            : key === 'latestCompactBoundary'
              ? 'Context compacted'
              : key === 'latestToolProgress'
                ? 'Tool progress'
                : key === 'rateLimit'
                  ? 'Usage limit'
                  : 'Transcript warning',
        detail: display(raw[key], 2000),
      });
  }
  return {
    provider,
    phase: ['idle', 'running', 'waiting', 'error'].includes(
      String(raw.runPhase),
    )
      ? String(raw.runPhase)
      : 'idle',
    canInterrupt: raw.canInterrupt === true,
    error: nullable(raw.lastError),
    model: nullable(raw.selectedModel),
    models: list(raw.availableModels)
      .slice(0, 100)
      .map((value) => {
        const m = record(value);
        return {
          id: display(m.id, 1000),
          label: display(m.displayName ?? m.id, 1000),
          ...(Array.isArray(m.reasoningEfforts)
            ? {
                reasoningEfforts: m.reasoningEfforts
                  .slice(0, 20)
                  .map((effort) => display(effort, 1000)),
              }
            : {}),
          ...(typeof m.supportsFastMode === 'boolean'
            ? { supportsFastMode: m.supportsFastMode }
            : {}),
        };
      }),
    reasoning: nullable(raw.reasoningEffort),
    fast: raw.fastMode === true,
    plan: raw.planMode === true,
    permissionMode: nullable(raw.permissionMode),
    permissionModes: permissionModes.slice(0, 20),
    context: raw.contextUsage
      ? {
          tokens: count(usage.totalTokens),
          limit: count(usage.maxTokens),
          percentage: Math.min(100, count(usage.percentage)),
        }
      : null,
    queue: list(raw.pendingPrompts)
      .slice(0, 50)
      .map((value) => {
        const p = record(value);
        return { id: display(p.id, 1000), text: display(p.prompt, 16000) };
      }),
    queuePaused: raw.queuePaused === true,
    permission:
      permission.requestId && !permissionQuestion
        ? {
            id: display(permission.requestId, 1000),
            title: display(
              permission.title ??
                permission.toolDisplayName ??
                permission.toolName,
              1000,
            ),
            description: display(
              permission.description ?? permission.decisionReason,
              4000,
            ),
            input: display(permission.batch ?? permission.input),
            allowAlways: permission.suppressAlwaysAllowRule !== true,
          }
        : null,
    question: question.requestId
      ? {
          id: display(question.requestId, 1000),
          message: display(question.message, 4000),
          questions,
          url: nullable(question.url),
        }
      : null,
    activity: activity.slice(-32),
  };
}

/** Take bounded tails before merging; opening a long transcript never copies its full history. */
export function chatWindow(
  history: readonly AgentTranscriptItem[],
  live: readonly AgentTranscriptItem[],
  before?: string,
) {
  const historyEnd = before
    ? history.findIndex((item) => item.id === before)
    : history.length;
  const liveEnd = before
    ? live.findIndex((item) => item.id === before)
    : live.length;
  if (before && historyEnd < 0 && liveEnd < 0) return null;
  const candidates = new Map<string, AgentTranscriptItem>();
  const hEnd = historyEnd < 0 ? history.length : historyEnd;
  for (const item of history.slice(Math.max(0, hEnd - 160), hEnd))
    candidates.set(item.id, item);
  if (!before || liveEnd >= 0)
    for (const item of live.slice(Math.max(0, liveEnd - 160), liveEnd))
      candidates.set(item.id, item);
  else
    for (const item of live)
      if (candidates.has(item.id)) candidates.set(item.id, item);
  const all = [...candidates.values()],
    items: ReturnType<typeof chatItem>[] = [];
  let bytes = 0,
    start = all.length;
  while (start > 0 && items.length < 80) {
    const item = chatItem(all[start - 1]);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 512 * 1024) break;
    bytes += size;
    start--;
    items.unshift(item);
  }
  return {
    items,
    before:
      start > 0 || hEnd > 160 || liveEnd > 160 ? (items[0]?.id ?? null) : null,
  };
}
