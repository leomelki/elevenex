import { record } from './desktop-chat-projection.js';

/**
 * Projects a runtime's background work and noteworthy events for the desktop
 * chat. `backgroundWork` is the runtime's authoritative live list; the
 * `tasks`/`subagents` ring buffers only enrich it and supply finished items.
 * Routine successes (hooks that passed, progress ticks) are deliberately
 * dropped: they are noise in a session-level summary.
 */
export interface ChatBackgroundWork {
  id: string;
  kind: 'agent' | 'task';
  /** Display label; includes the role for desktops that predate `title`/`role`. */
  label: string;
  /** Primary task title, or the label without a separately reported role. */
  title?: string;
  /** Agent nickname, secondary to a delegated task title when supplied. */
  agentName?: string;
  /** Harness agent type (for example `reviewer`), when not already in the label. */
  role?: string;
  detail: string;
  startedAt: string | null;
  stoppable: boolean;
  orphaned: boolean;
  tokens?: number;
  toolUses?: number;
  status?: ReturnType<typeof agentStatus>;
  background?: boolean;
  agentId?: string;
  inspectable?: boolean;
  canBackground?: boolean;
  model?: string;
  context?: ReturnType<typeof agentContext>;
}
export interface ChatWorkEvent {
  id: string;
  kind:
    | 'finished'
    | 'hook'
    | 'retry'
    | 'compaction'
    | 'notification'
    | 'transcript'
    | 'plugin';
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  detail: string;
  at: string | null;
  agentId?: string;
}
export interface ChatWork {
  running: ChatBackgroundWork[];
  recent: ChatWorkEvent[];
  totalRunning?: number;
}
/** Which stop operations the selected harness actually implements. */
export interface ChatWorkControls {
  stopTask: boolean;
  stopAgent: boolean;
  inspectAgent?: boolean;
  backgroundAgent?: boolean;
}

const MAX_RUNNING = 16;
const MAX_RECENT = 12;
const MAX_FINISHED = 6;
const LIVE_TASK = new Set(['pending', 'running', 'paused']);
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';
const clip = (value: string, limit: number): string =>
  value.length > limit ? value.slice(0, limit - 1).trimEnd() + '…' : value;
/** First non-empty line, bounded; multi-line provider messages stay readable in a row. */
const line = (value: unknown, limit = 240): string =>
  clip(
    text(value)
      .split('\n')
      .find((part) => part.trim())
      ?.trim() ?? '',
    limit,
  );
/** Hook output explains failures at its end, so keep the last lines. */
const tail = (value: unknown, limit = 600): string => {
  const output = text(value);
  return output.length > limit ? '…' + output.slice(-(limit - 1)) : output;
};
const iso = (value: unknown): string | null => {
  const time =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(time) && Number.isFinite(new Date(time).getTime())
    ? new Date(time).toISOString()
    : null;
};
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
const tokens = (value: number): string =>
  new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
    .format(value)
    .toLowerCase();

/** Preserve provider states instead of treating every stopped lifecycle as success. */
export function agentStatus(agent: Record<string, unknown>) {
  if (agent.stoppedByUser === true && agent.status === 'stopped')
    return 'stopped';
  const value = text(agent.executionStatus);
  switch (value) {
    case 'pending':
    case 'running':
    case 'waiting':
    case 'paused':
    case 'completed':
    case 'interrupted':
    case 'error':
    case 'closed':
    case 'unavailable':
      return value;
    default:
      return agent.stoppedByUser === true
        ? 'stopped'
        : agent.status === 'started'
          ? 'running'
          : 'completed';
  }
}
export function agentContext(value: unknown) {
  const usage = record(value);
  const used = count(usage.totalTokens),
    limit = count(usage.maxTokens);
  if (used === undefined || !limit) return undefined;
  return {
    tokens: used,
    limit,
    percentage: Math.min(100, Math.round((used / limit) * 100)),
  };
}
function running(
  raw: Record<string, unknown>,
  controls: ChatWorkControls,
): ChatBackgroundWork[] {
  const tasks = new Map(
    list(raw.tasks).map((task) => [text(task.taskId), task]),
  );
  const agents = new Map(
    list(raw.subagents).map((agent) => [text(agent.agentId), agent]),
  );
  const background = list(raw.backgroundWork);
  const foregroundActive =
    raw.runPhase === 'running' || raw.runPhase === 'waiting';
  const backgroundIds = new Set(background.map((item) => text(item.id)));
  const agentTasks = new Map(
    [...agents.values()]
      .filter((agent) => text(agent.taskId))
      .map((agent) => [text(agent.taskId), agent]),
  );
  const live = new Map(background.map((item) => [text(item.id), item]));
  // Foreground child agents have useful controls too. Never infer detached shell
  // work from historical tool calls; only the runtime can establish its lifetime.
  for (const [id, agent] of agents) {
    if (
      !foregroundActive ||
      agent.isBackgrounded !== false ||
      !id ||
      agent.status !== 'started' ||
      live.has(`task:${text(agent.taskId) || id}`) ||
      live.has(`subagent:${id}`)
    )
      continue;
    live.set(`subagent:${id}`, {
      id: `subagent:${id}`,
      kind: 'subagent',
      label: agent.displayName ?? agent.agentType,
      startedAt: agent.startedAt ?? agent.timestamp,
    });
  }
  return [...live.values()]
    .flatMap((item): ChatBackgroundWork[] => {
      const id = text(item.id),
        split = id.indexOf(':'),
        prefix = id.slice(0, split),
        key = id.slice(split + 1);
      if (
        split < 1 ||
        !key ||
        id.length > 400 ||
        (prefix !== 'task' && prefix !== 'subagent')
      )
        return [];
      const task = prefix === 'task' ? tasks.get(key) : undefined;
      const agent = agents.get(key) ?? agentTasks.get(key);
      const parent = task ? tasks.get(text(task.parentTaskId)) : undefined;
      const usage = record(task?.usage ?? agent?.usage),
        tool = text(task?.lastToolName ?? agent?.lastToolName);
      const kind = item.kind === 'subagent' || agent ? 'agent' : 'task';
      const type = text(agent?.agentType ?? task?.subagentType);
      const label =
        line(item.label, 200) ||
        line(agent?.displayName, 200) ||
        (kind === 'agent' ? 'Agent' : 'Background task');
      const context = agentContext(agent?.contextUsage);
      const taskTitle = line(agent?.taskTitle, 120);
      const agentName = line(agent?.displayName, 160);
      const role =
        kind === 'agent' &&
        type &&
        !label.toLowerCase().includes(type.toLowerCase())
          ? line(type, 80)
          : '';
      return [
        {
          id,
          kind,
          label: role ? clip(`${label} · ${role}`, 240) : label,
          ...(role ? { title: label, role } : {}),
          ...(taskTitle
            ? {
                title: taskTitle,
                ...(agentName &&
                agentName.toLowerCase() !== taskTitle.toLowerCase()
                  ? { agentName }
                  : {}),
              }
            : {}),
          detail:
            line(task?.summary) ||
            line(item.detail) ||
            line(agent?.lastAssistantMessage) ||
            (tool ? `Last used ${tool}` : ''),
          startedAt: iso(item.startedAt),
          stoppable:
            prefix === 'task'
              ? controls.stopTask && task?.canStop === true
              : controls.stopAgent && agent?.canStop === true,
          orphaned: !!parent && !LIVE_TASK.has(text(parent.status)),
          status: agent
            ? agentStatus(agent)
            : text(task?.status) === 'paused'
              ? 'paused'
              : text(task?.status) === 'pending'
                ? 'pending'
                : 'running',
          background:
            backgroundIds.has(id) &&
            (agent?.isBackgrounded !== false || !foregroundActive),
          ...(agent
            ? {
                agentId: text(agent.agentId),
                inspectable: controls.inspectAgent === true,
                canBackground:
                  controls.backgroundAgent === true &&
                  agent.canBackground === true,
              }
            : {}),
          ...(text(agent?.model) ? { model: line(agent?.model, 160) } : {}),
          ...(context ? { context } : {}),
          ...(count(usage.totalTokens) !== undefined
            ? { tokens: count(usage.totalTokens) }
            : {}),
          ...(count(usage.toolUses) !== undefined
            ? { toolUses: count(usage.toolUses) }
            : {}),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.status === 'waiting') - Number(a.status === 'waiting') ||
        (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    );
}

function finished(
  raw: Record<string, unknown>,
  live: Set<string>,
  controls: ChatWorkControls,
): ChatWorkEvent[] {
  const events: ChatWorkEvent[] = [];
  const covered = new Set<string>();
  const agents = list(raw.subagents);
  const byTask = new Map(
    agents.map((agent) => [text(agent.taskId) || text(agent.agentId), agent]),
  );
  for (const task of list(raw.tasks)) {
    const id = text(task.taskId);
    const status = text(task.status);
    const agent = byTask.get(id);
    // Foreground tasks already appear in the transcript; ambient work is internal.
    if (
      !id ||
      (task.isBackgrounded !== true && !agent) ||
      task.ambient === true ||
      task.skipTranscript === true ||
      task.taskType === 'task_board' ||
      LIVE_TASK.has(status) ||
      live.has(`task:${id}`)
    )
      continue;
    covered.add(id);
    const label =
      line(task.description, 200) ||
      line(task.subject, 200) ||
      line(task.workflowName, 200) ||
      'Background task';
    const failed = status === 'failed' || status === 'error';
    const unknown = ['interrupted', 'unavailable', 'closed'].includes(status);
    const stopped = status === 'killed' || status === 'stopped';
    events.push({
      id: clip(`finished:task:${id}`, 400),
      kind: 'finished',
      ...(controls.inspectAgent && agent
        ? { agentId: text(agent.agentId) }
        : {}),
      tone: failed
        ? 'danger'
        : unknown
          ? 'warning'
          : stopped
            ? 'info'
            : 'success',
      title: `${label} ${failed ? 'failed' : stopped ? 'stopped' : unknown ? status : 'finished'}`,
      detail: failed
        ? line(task.error, 400) || line(task.summary)
        : line(task.summary),
      at: iso(task.endTime) ?? iso(task.updatedAt),
    });
  }
  for (const agent of agents) {
    const id = text(agent.agentId);
    if (
      !id ||
      covered.has(id) ||
      covered.has(text(agent.taskId)) ||
      agent.status !== 'stopped' ||
      live.has(`subagent:${id}`)
    )
      continue;
    const status = agentStatus(agent);
    const failed = status === 'error';
    const ended =
      status === 'interrupted' ||
      status === 'closed' ||
      status === 'unavailable';
    const label =
      line(agent.taskTitle, 120) ||
      line(agent.displayName, 200) ||
      line(agent.agentType, 200) ||
      'Agent';
    events.push({
      id: clip(`finished:subagent:${id}`, 400),
      kind: 'finished',
      ...(controls.inspectAgent ? { agentId: id } : {}),
      tone: failed
        ? 'danger'
        : ended
          ? status === 'closed'
            ? 'info'
            : 'warning'
          : agent.stoppedByUser === true
            ? 'info'
            : 'success',
      title: `${label} ${failed ? 'failed' : ended ? status : agent.stoppedByUser === true ? 'stopped' : 'finished'}`,
      detail: line(agent.lastAssistantMessage),
      at: iso(agent.completedAt) ?? iso(agent.timestamp),
    });
  }
  return events
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, MAX_FINISHED);
}

function hooks(raw: Record<string, unknown>): ChatWorkEvent[] {
  return list(raw.hooks).flatMap((hook): ChatWorkEvent[] => {
    // Running and successful hooks are routine automation, not activity.
    if (hook.status !== 'error' && hook.status !== 'cancelled') return [];
    const name = line(hook.hookName, 200);
    const event = line(hook.hookEvent, 200);
    const exit = count(hook.exitCode);
    const output = tail(hook.stderr) || tail(hook.output) || tail(hook.stdout);
    return [
      {
        id: clip(`hook:${text(hook.hookId) || name}`, 400),
        kind: 'hook',
        tone: hook.status === 'error' ? 'danger' : 'warning',
        title: `${name || event || 'Hook'} ${hook.status === 'error' ? 'failed' : 'was cancelled'}`,
        detail: [
          event && name && event !== name ? event : '',
          exit !== undefined && exit !== 0 ? `exit ${exit}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
          .concat(output ? `\n${output}` : '')
          .trim(),
        at: iso(hook.updatedAt) ?? iso(hook.startedAt),
      },
    ];
  });
}

function signals(raw: Record<string, unknown>): ChatWorkEvent[] {
  const events: ChatWorkEvent[] = [];
  const active = raw.runPhase === 'running' || raw.runPhase === 'waiting';
  const retry = record(raw.latestApiRetry);
  const runStarted = Date.parse(text(record(raw.lastPromptTiming).startedAt));
  // The runtime keeps its last retry forever; it only matters while that run lasts.
  if (
    raw.latestApiRetry &&
    active &&
    !(Date.parse(text(retry.timestamp)) < runStarted)
  ) {
    const status = count(retry.errorStatus);
    events.push({
      id: `retry:${text(retry.timestamp)}`,
      kind: 'retry',
      tone: 'warning',
      title:
        count(retry.attempt) && count(retry.maxRetries)
          ? `Retrying request · attempt ${count(retry.attempt)} of ${count(retry.maxRetries)}`
          : count(retry.attempt)
            ? `Retrying request · attempt ${count(retry.attempt)}`
            : 'Retrying request',
      detail: [
        status ? `HTTP ${status}` : '',
        count(retry.retryDelayMs)
          ? `Retry delay ${Math.ceil(Number(retry.retryDelayMs) / 1000)}s`
          : '',
        line(retry.error, 400),
      ]
        .filter(Boolean)
        .join(' · '),
      at: iso(retry.timestamp),
    });
  }
  const compact = record(raw.latestCompactBoundary);
  if (raw.latestCompactBoundary) {
    const before = count(compact.preTokens);
    const after = count(compact.postTokens);
    events.push({
      id: `compaction:${text(compact.timestamp)}`,
      kind: 'compaction',
      tone: 'info',
      title: 'Context compacted',
      detail: [
        before !== undefined
          ? after !== undefined
            ? `${tokens(before)} → ${tokens(after)} tokens`
            : `from ${tokens(before)} tokens`
          : '',
        compact.trigger === 'manual'
          ? 'Manual'
          : compact.trigger === 'auto'
            ? 'Automatic'
            : '',
      ]
        .filter(Boolean)
        .join(' · '),
      at: iso(compact.timestamp),
    });
  }
  for (const note of list(raw.notifications).slice(-3)) {
    const title = line(note.text, 240);
    if (!title) continue;
    events.push({
      id: clip(`notification:${text(note.key)}:${text(note.timestamp)}`, 400),
      kind: text(note.key) === 'compaction' ? 'compaction' : 'notification',
      tone:
        note.priority === 'high' || note.priority === 'immediate'
          ? 'warning'
          : 'info',
      title,
      detail: '',
      at: iso(note.timestamp),
    });
  }
  const mirror = record(raw.latestMirrorError);
  if (raw.latestMirrorError)
    events.push({
      id: `transcript:${text(mirror.timestamp)}`,
      kind: 'transcript',
      tone: 'warning',
      title: 'Transcript sync problem',
      detail: line(mirror.error, 400),
      at: iso(mirror.timestamp),
    });
  const plugin = record(raw.latestPluginInstall);
  if (plugin.status === 'failed')
    events.push({
      id: `plugin:${text(plugin.timestamp)}`,
      kind: 'plugin',
      tone: 'danger',
      title: `Plugin ${line(plugin.name, 200) || 'install'} failed`,
      detail: line(plugin.error, 400),
      at: iso(plugin.timestamp),
    });
  return events;
}

export function chatWork(
  raw: Record<string, unknown>,
  controls: ChatWorkControls,
): ChatWork {
  const live = running(raw, controls);
  const ids = new Set(live.map((item) => item.id));
  const recent = [
    ...finished(raw, ids, controls),
    ...hooks(raw),
    ...signals(raw),
  ]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, MAX_RECENT);
  return {
    running: live.slice(0, MAX_RUNNING),
    recent,
    totalRunning: live.length,
  };
}

/** The flat shape older desktops render: live work plus events needing attention. */
export function legacyActivity(work: ChatWork) {
  return [
    ...work.running.map((item) => ({
      id: item.id,
      label: item.label,
      detail: item.detail || 'Running in background',
    })),
    ...work.recent
      .filter((event) => event.tone === 'warning' || event.tone === 'danger')
      .map((event) => ({
        id: event.id,
        label: event.title,
        detail: event.detail,
      })),
  ].slice(0, 32);
}
