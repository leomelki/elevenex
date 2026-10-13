import type { ResultSummary, ToolLike } from './agent-tool-format';
import { adaptElevenexResult, adaptElevenexRow } from './elevenex-tool-adapters';

type RecordValue = Record<string, unknown>;
export type ElevenexActionCategory = 'observe' | 'setup' | 'drive' | 'communicate' | 'work';
export interface ElevenexToolMeta {
  icon: string;
  verb: string;
  category: ElevenexActionCategory;
}
export interface ElevenexField {
  label: string;
  value: string;
  link?: string;
  mono?: boolean;
}
export interface ElevenexRow {
  title: string;
  detail: string;
  link?: string;
  status?: ResultSummary;
}
export interface ElevenexToolView {
  tool: string;
  title: string;
  target: string;
  summary: ResultSummary | null;
  fields: ElevenexField[];
  rows: ElevenexRow[];
  listLabel: string;
  notice: string;
  content: string;
  contentLabel: string;
  error: { message: string; code: string; remediation: string; fields: ElevenexField[] } | null;
  toolFailed: boolean;
  listEmpty: boolean;
  link?: string;
  linkLabel: string;
  more: boolean;
}

const metas: Record<string, ElevenexToolMeta> = {};
function group(category: ElevenexActionCategory, icon: string, labels: Record<string, string>) {
  for (const [tool, verb] of Object.entries(labels)) metas[tool] = { category, icon, verb };
}
group('observe', 'lucideSearch', {
  find_sessions: 'Find conversations',
  find_branches: 'Find branches',
  text_search: 'Search files',
  file_search: 'Find files',
  grep_session: 'Search conversation',
});
group('observe', 'lucideLayoutDashboard', {
  project_overview: 'Project overview',
  get_current_session: 'Session context',
  get_session_config: 'Session configuration',
  get_focused_session: 'Focused session',
  get_task: 'Inspect task',
});
group('observe', 'lucideTimer', {
  await_task_ready: 'Wait for task setup',
  await_session_event: 'Wait for conversation',
  poll_session_status: 'Wait for completion',
  session_status: 'Conversation status',
  preview_finish_task: 'Preview task finish',
});
group('observe', 'lucideFileText', {
  read_session: 'Read conversation',
  read_session_range: 'Read conversation',
  read_file: 'Read file',
  get_worktree_context: 'Checkout context',
  read_task_draft: 'Read task draft',
  list_scratchpad: 'Find project notes',
  read_scratchpad: 'Read project note',
  list_todos: 'Project checklist',
  list_tasks: 'Find tasks',
  list_session_folders: 'Conversation folders',
});
group('setup', 'lucideGitBranch', {
  get_task_defaults: 'Task setup suggestions',
  create_task: 'Create task',
  retry_task: 'Retry task setup',
  reopen_task: 'Reopen task',
  assess_worktree_pool: 'Inspect checkout pool',
  generate_worktree_context: 'Summarize checkout',
});
group('setup', 'lucidePlusCircle', {
  create_session: 'Add conversation',
  open_task_session: 'Open task conversation',
  find_or_create_project: 'Find or create project',
  add_repo: 'Add repository',
  create_session_folder: 'Create conversation folder',
  set_action: 'Save command',
});
group('setup', 'lucidePencilLine', {
  rename_task: 'Rename task',
  move_task: 'Reorder task',
  set_task_draft: 'Stage task draft',
  set_scratchpad: 'Save project note',
  set_todo: 'Update checklist',
  rename_session_folder: 'Rename conversation folder',
  move_session_to_folder: 'Move conversation',
});
group('drive', 'lucideArchive', {
  finish_task: 'Finish task',
  archive_session: 'Archive conversation',
  unarchive_session: 'Restore conversation',
  archive_session_folder: 'Archive folder',
  unarchive_session_folder: 'Restore folder',
});
group('drive', 'lucideMessageSquare', {
  prompt_session: 'Prompt conversation',
  ask_session: 'Ask about conversation',
  fork_session: 'Fork conversation',
  rename_session: 'Rename conversation',
});
group('drive', 'lucideSettings', {
  interrupt_session: 'Stop conversation',
  reset_session: 'Reset conversation',
  get_pending_action: 'Pending decision',
  resolve_action: 'Resolve decision',
  set_provider: 'Change provider',
  set_model: 'Change model',
  set_permission_mode: 'Change permissions',
});
group('work', 'lucideTerminal', {
  list_actions: 'Saved commands',
  run_action: 'Run saved command',
  stop_action: 'Stop saved command',
  read_action_output: 'Read command output',
  poll_action_status: 'Wait for command',
});
group('setup', 'lucideTrash2', {
  delete_project: 'Delete project',
  remove_repo: 'Remove repository',
  delete_action: 'Delete saved command',
  delete_session_folder: 'Delete conversation folder',
});
group('communicate', 'lucideBell', {
  notify_user: 'Notify you',
  show_user: 'Show you',
  request_approval: 'Request approval',
  escalate_to_user: 'Ask you',
  select_paths: 'Ask you to select paths',
});
// Historical transcripts still render the old worktree operations.
group('setup', 'lucideGitBranch', {
  create_worktree: 'Create checkout',
  link_worktree: 'Assign checkout',
  steal_worktree: 'Take over checkout',
  switch_branch: 'Switch branch',
  rename_worktree: 'Rename checkout',
  delete_worktree: 'Delete checkout',
  get_worktree_job: 'Checkout setup',
});
group('observe', 'lucideGitCompare', { change_review: 'Review changes' });
export const ELEVENEX_TOOL_META: Readonly<Record<string, ElevenexToolMeta>> = metas;

function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
function short(value: string, max = 100): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}
function id(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
export function elevenexToolName(tool: ToolLike & { providerToolName?: string }): string | null {
  const input = record(tool.toolInput);
  if (input?.['server'] === 'elevenex' && typeof input['tool'] === 'string')
    return input['tool'].replace(/\./g, '_');
  const match = (tool.toolName || tool.providerToolName || '').match(
    /^(?:mcp__elevenex__|elevenex[_.:])(.+)$/,
  );
  return match ? match[1].replace(/\./g, '_') : null;
}
export function elevenexArguments(input: unknown): RecordValue {
  const data = record(input) ?? {};
  return record(data['arguments']) ?? record(data['args']) ?? data;
}
/** Only app routes returned by trusted tool primitives become navigation links. */
export function elevenexLink(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^\/(?:tasks|sessions|projects)\/\d+(?:\?[^\s]*)?$/.test(value)
    ? value
    : undefined;
}
/** Unwrap all providers' MCP forms, including structuredContent and nested text blocks. */
export function elevenexEnvelope(content: unknown, depth = 0): RecordValue | null {
  if (depth > 6 || content == null) return null;
  if (typeof content === 'string') {
    if (content.length > 2_000_000) return null;
    const raw = content.replace(/^\s*<tool_use_error>|<\/tool_use_error>\s*$/g, '').trim();
    try {
      return elevenexEnvelope(JSON.parse(raw), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = elevenexEnvelope(block, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  const data = record(content);
  if (!data) return null;
  if (
    Object.hasOwn(data, 'data') ||
    (record(data['error']) && typeof record(data['error'])!['message'] === 'string')
  )
    return data;
  for (const key of ['structuredContent', 'details', 'content', 'text', 'result']) {
    const parsed = elevenexEnvelope(data[key], depth + 1);
    if (parsed) return parsed;
  }
  return null;
}
const stateLabels: Record<string, string> = {
  success: 'Succeeded',
  error: 'Failed',
  preparing: 'Preparing',
  refreshing_ref: 'Refreshing branch',
  preparing_checkout: 'Preparing checkout',
  restoring_sessions: 'Restoring conversations',
  ready: 'Ready',
  failed: 'Failed',
  finishing: 'Finishing',
  running: 'Running',
  created: 'Not started',
  stopped: 'Stopped',
  completed: 'Completed',
  archived: 'Archived',
  requires_action: 'Needs your input',
  idle: 'Idle',
  generating: 'Generating',
  pending: 'Pending',
};
function status(value: unknown): ResultSummary | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return {
    text: stateLabels[value] ?? value.replace(/_/g, ' '),
    tone: ['failed', 'error'].includes(value)
      ? 'error'
      : ['preparing', 'finishing', 'running', 'pending', 'requires_action', 'generating'].includes(
            value,
          )
        ? 'warn'
        : ['ready', 'completed', 'succeeded', 'success'].includes(value)
          ? 'ok'
          : 'neutral',
  };
}
function provider(value: unknown): string {
  const raw = text(value);
  return (
    (
      { claude: 'Claude', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode' } as Record<string, string>
    )[raw] ?? raw
  );
}
function fieldsFor(data: RecordValue): ElevenexField[] {
  const fields: ElevenexField[] = [];
  const add = (label: string, value: unknown, link?: string, mono = false) => {
    const valueText = text(value);
    if (valueText) fields.push({ label, value: valueText, link, mono });
  };
  const task = id(data['taskId']);
  const session = id(data['sessionId']);
  const project = id(data['projectId']);
  if (task)
    add(
      'Task',
      `${text(data['taskName']) || (!session ? text(data['name']) : '') || 'Task'} · #${task}`,
      `/tasks/${task}`,
    );
  if (session)
    add(
      'Conversation',
      `${text(data['name']) || 'Conversation'} · #${session}`,
      `/sessions/${session}`,
    );
  if (project)
    add('Project', text(data['projectName']) || `Project #${project}`, `/projects/${project}`);
  add(
    'Repository',
    data['repoName'] ?? (id(data['repoId']) ? `Repository #${data['repoId']}` : ''),
  );
  add('Branch', data['branchName'] ?? data['branch']);
  add('Source ref', data['sourceRef'] ?? data['baseRef'], undefined, true);
  add('Checkout', data['environmentPath'] ?? data['worktreePath'], undefined, true);
  add('Provider', provider(data['provider']));
  add('Model', data['model']);
  add('Permissions', data['permissionMode']);
  add('Existing checkout', data['path'], undefined, true);
  if (id(data['existingTaskId']))
    add('Existing task', `Task #${data['existingTaskId']}`, `/tasks/${data['existingTaskId']}`);
  if (data['canSnapshot'] === true) add('Alternative', 'Independent committed snapshot');
  add('Setup stage', stateLabels[text(data['preparationStage'])]);
  add(
    'Checkout mode',
    data['checkoutMode'] === 'snapshot'
      ? 'Independent snapshot'
      : data['checkoutMode'] === 'branch'
        ? 'Branch'
        : '',
  );
  if (data['planMode'] === true) add('Mode', 'Planning');
  for (const [key, label] of Object.entries({
    agents: 'Running agents',
    terminals: 'Running terminals',
    actions: 'Running commands',
    sessionCount: 'Conversations',
    lastExitCode: 'Last exit code',
    exitCode: 'Exit code',
    draftLength: 'Draft characters',
    contentLength: 'Note characters',
    totalCharacters: 'Total characters',
    startLine: 'First line',
    endLine: 'Last line',
    totalLines: 'Total lines',
    newTurns: 'Returned turns',
    totalTurns: 'Total turns',
    durationSeconds: 'Duration (seconds)',
  })) {
    if (typeof data[key] === 'number') add(label, data[key]);
  }
  return fields;
}
function rowView(row: unknown, kind: string): ElevenexRow {
  if (typeof row === 'string') return { title: row, detail: '' };
  const data = record(row) ?? {};
  const key = id(data['taskId']) ?? id(data['sessionId']) ?? id(data['id']);
  let link = elevenexLink(data['deepLink']);
  if (!link && key && kind === 'tasks') link = `/tasks/${key}`;
  if (!link && key && kind === 'sessions') link = `/sessions/${key}`;
  if (!link && key && kind === 'projects') link = `/projects/${key}`;
  const title =
    text(data['name']) ||
    text(data['text']) ||
    text(data['path']) ||
    text(data['ref']) ||
    text(data['command']) ||
    (key ? `${kind === 'sessions' ? 'Conversation' : kind.slice(0, -1)} #${key}` : 'Result');
  const detail = [
    text(data['branch'] ?? data['branchName']),
    provider(data['provider']),
    text(data['ref']),
    text(data['command']),
    text(data['description']),
    typeof data['sessionCount'] === 'number' ? `${data['sessionCount']} conversations` : '',
    typeof data['contentLength'] === 'number' ? `${data['contentLength']} characters` : '',
    text(data['worktreePath']),
    typeof data['line'] === 'number' ? `line ${data['line']}` : '',
    text(data['preview'] ?? data['snippet']),
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title: short(title, 220),
    detail: short(detail, 360),
    link,
    status:
      kind === 'tasks' && data['finishedAt']
        ? { text: 'Finished', tone: 'neutral' }
        : data['archived']
          ? { text: 'Archived', tone: 'neutral' }
          : data['completed'] === true
            ? { text: 'Completed', tone: 'ok' }
            : status(data['state'] ?? data['status']),
  };
}
const recovery: Record<string, string> = {
  active_tasks:
    'Finish the active tasks first so their agents, commands, terminals, and checkout preparation can be cleaned up safely.',
  branch_in_use:
    'This branch is already assigned. Open the existing task, or ask the agent to prepare an independent snapshot.',
  environment_reserved:
    'Another task reserved this checkout. Choose another checkout or an independent snapshot.',
  external_checkout:
    'This checkout is external or contains local edits. Choose whether to use it or review a committed snapshot.',
  remote_differs:
    'The local branch differs from the remote. Choose the source to keep, or use an independent snapshot.',
  environment_missing: 'Reopen or retry task setup to acquire a checkout.',
  running_work:
    'Finishing would stop active agents, terminals, or commands. Review these counts before approving.',
  self_target_not_allowed:
    'Finish or stop this task from Elevenex after the current agent turn ends.',
  no_current_task: 'This conversation is not attached to a task. Choose a task for this operation.',
  scope_required:
    'Choose the task, conversation, repository, or checkout this operation should use.',
};
const listLabels: Record<string, [string, string]> = {
  tasks: ['Task', 'Tasks'],
  sessions: ['Conversation', 'Conversations'],
  projects: ['Project', 'Projects'],
  repos: ['Repository', 'Repositories'],
  worktrees: ['Checkout', 'Checkouts'],
  folders: ['Folder', 'Folders'],
  actions: ['Command', 'Commands'],
  branches: ['Branch', 'Branches'],
  todos: ['Todo', 'Todos'],
  sections: ['Section', 'Sections'],
  matches: ['Match', 'Matches'],
  results: ['Result', 'Results'],
  files: ['File', 'Files'],
  models: ['Model', 'Models'],
};
export function buildElevenexToolView(
  call: ToolLike,
  result: { content?: unknown; isError?: boolean } | null,
): ElevenexToolView | null {
  const tool = elevenexToolName(call);
  if (!tool) return null;
  const meta = metas[tool] ?? {
    verb: tool.replace(/_/g, ' '),
    icon: 'lucidePlugZap',
    category: 'work' as const,
  };
  const args = elevenexArguments(call.toolInput);
  const envelope = result ? elevenexEnvelope(result.content) : null;
  const data = record(envelope?.['data']) ?? {};
  const workflowError = record(data['error']);
  const error = record(envelope?.['error']) ?? workflowError;
  const toolFailed = !!result && (result.isError === true || !!record(envelope?.['error']));
  const errorView = error
    ? {
        message: text(error['message']) || 'The operation could not complete.',
        code: text(error['code']),
        remediation:
          recovery[text(error['code'])] ??
          (text(error['remediation']).match(/\b[a-z]+_[a-z]+\b/)
            ? 'The agent can inspect the task and choose a recovery step.'
            : text(error['remediation'])),
        fields: fieldsFor(record(error['details']) ?? error),
      }
    : toolFailed
      ? {
          message: short(
            typeof result?.content === 'string'
              ? result.content
              : 'The tool returned an error. Open technical details for the full response.',
            600,
          ),
          code: '',
          remediation: '',
          fields: [],
        }
      : null;
  const fieldData = { ...data, ...(record(data['focused']) ?? {}) };
  const fields = fieldsFor({ ...args, ...fieldData });
  const adapter = adaptElevenexResult(tool, data);
  fields.push(...(adapter.fields ?? []));
  const target = short(
    text(
      data['name'] ??
        fieldData['taskName'] ??
        fieldData['branchName'] ??
        args['name'] ??
        args['branchName'] ??
        args['query'] ??
        args['path'],
    ) ||
      (id(args['taskId'])
        ? `Task #${args['taskId']}`
        : id(args['sessionId'])
          ? `Conversation #${args['sessionId']}`
          : id(args['repoId'])
            ? `Repository #${args['repoId']}`
            : tool.includes('task')
              ? 'Current task'
              : tool === 'get_current_session'
                ? 'Current session'
                : ''),
    100,
  );
  const collectionKeys = [
    'tasks',
    'sessions',
    'projects',
    'repos',
    'worktrees',
    'folders',
    'actions',
    'branches',
    'todos',
    'sections',
    'matches',
    'results',
    'files',
    'models',
  ];
  const listKey = collectionKeys.find((key) => Array.isArray(data[key]));
  const collection = listKey
    ? (data[listKey] as unknown[])
    : Array.isArray(envelope?.['data'])
      ? (envelope!['data'] as unknown[])
      : [];
  const rows = collection
    .slice(0, 20)
    .map((row) =>
      rowView(
        adaptElevenexRow(tool, row),
        listKey ?? (tool === 'list_tasks' ? 'tasks' : 'results'),
      ),
    );
  const labels = listLabels[listKey ?? 'results'];
  const listLabel = labels[1];
  const countSummary = `${collection.length} ${labels[collection.length === 1 ? 0 : 1].toLowerCase()}`;
  let summary: ResultSummary | null = result
    ? envelope
      ? { text: 'Completed', tone: 'ok' }
      : { text: 'Response received', tone: 'neutral' }
    : null;
  if (errorView)
    summary = { text: toolFailed ? 'Could not complete' : 'Needs attention', tone: 'error' };
  else if (
    data['timedOut'] === true ||
    data['stillRunning'] === true ||
    data['hasQueuedWork'] === true
  )
    summary = { text: tool.includes('task') ? 'Setup continuing' : 'Still running', tone: 'warn' };
  else if (
    listKey &&
    (tool.startsWith('list_') || tool.startsWith('find_') || tool === 'project_overview')
  )
    summary = { text: countSummary, tone: 'neutral' };
  else if (data['state'] || data['runtimeState'] || data['status'] || data['generationStatus'])
    summary =
      status(data['state'] ?? data['runtimeState'] ?? data['status'] ?? data['generationStatus']) ??
      summary;
  else if (listKey || Array.isArray(envelope?.['data']))
    summary = { text: countSummary, tone: 'neutral' };
  else if (tool === 'preview_finish_task')
    summary = {
      text: `${Number(data['agents'] ?? 0) + Number(data['terminals'] ?? 0) + Number(data['actions'] ?? 0)} running processes`,
      tone:
        Number(data['agents'] ?? 0) + Number(data['terminals'] ?? 0) + Number(data['actions'] ?? 0)
          ? 'warn'
          : 'ok',
    };
  else if (tool === 'set_task_draft' && data['saved'] === true)
    summary = { text: 'Draft saved', tone: 'ok' };
  else if (tool === 'move_task' && data['moved'] === true)
    summary = { text: 'Reordered', tone: 'ok' };
  if (!errorView && result && adapter.summary) summary = adapter.summary;
  if (tool === 'get_current_session' && envelope && !errorView)
    summary = { text: 'Context resolved', tone: 'ok' };
  if (tool === 'get_focused_session' && data['focused'] === null)
    summary = { text: 'No focused conversation', tone: 'neutral' };
  if (tool === 'read_session' && typeof data['newTurns'] === 'number')
    summary = {
      text: `${data['newTurns']} ${data['delta'] ? 'new' : ''} turns`.replace(/  /g, ' '),
      tone: 'neutral',
    };
  const more =
    collection.length > rows.length ||
    envelope?.['truncated'] === true ||
    data['nextCursor'] != null ||
    data['nextOffset'] != null ||
    data['nextSessionOffset'] != null;
  const notice =
    adapter.notice ??
    (data['hasQueuedWork'] === true
      ? 'Background work or queued prompts are still active.'
      : data['state'] === 'preparing'
        ? 'The checkout is being prepared. Coding work has not started.'
        : tool === 'set_task_draft' && data['saved'] === true
          ? 'Saved to the composer. No prompt was sent.'
          : data['checkoutMode'] === 'snapshot'
            ? 'Independent committed snapshot; edits in another checkout are not included.'
            : tool === 'create_session' || tool === 'fork_session'
              ? 'This conversation shares its task’s files and checkout.'
              : '');
  const content = text(
    data['content'] ??
      data['text'] ??
      data['markdown'] ??
      data['answer'] ??
      data['contextSentence'] ??
      data['output'] ??
      data['outputTail'] ??
      adapter.content ??
      (tool === 'fork_session' ? data['draft'] : undefined) ??
      (['set_task_draft', 'set_scratchpad'].includes(tool)
        ? (args['text'] ?? args['content'])
        : undefined) ??
      (tool === 'prompt_session'
        ? args['prompt']
        : tool === 'ask_session'
          ? args['question']
          : undefined),
  );
  const link = elevenexLink(envelope?.['deepLink']);
  if (tool === 'move_task')
    fields.push({
      label: 'Position',
      value: id(args['beforeTaskId'])
        ? `Before task #${args['beforeTaskId']}`
        : 'End of the task list',
    });
  return {
    tool,
    title: meta.verb,
    target,
    summary: result ? summary : null,
    fields,
    rows,
    listLabel,
    notice,
    content,
    contentLabel:
      tool === 'set_action'
        ? 'Saved command'
        : tool === 'prompt_session'
          ? result && !toolFailed
            ? 'Prompt sent'
            : 'Prompt'
          : tool.includes('draft')
            ? 'Saved draft'
            : tool.includes('scratchpad')
              ? 'Project note'
              : tool === 'ask_session'
                ? typeof data['answer'] === 'string'
                  ? 'Answer'
                  : 'Question'
                : 'Returned content',
    error: errorView,
    toolFailed,
    listEmpty: !!result && !!listKey && collection.length === 0,
    link,
    linkLabel: link?.startsWith('/tasks/')
      ? 'Open task'
      : link?.startsWith('/sessions/')
        ? 'Open conversation'
        : 'Open project',
    more,
  };
}
