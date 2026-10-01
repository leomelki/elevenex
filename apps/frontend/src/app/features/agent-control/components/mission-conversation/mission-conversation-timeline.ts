import {
  contentToString,
  describeAgentTool,
  resultSummary,
  shouldHideToolCall,
  type ResultSummary,
} from '@/shared/agent-tools/agent-tool-format';
import type { AgentShow } from '@/shared/models/agent-channel.model';
import type {
  ClaudeToolUseSummary,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';

/** The four families of elevenex actions, used to tint timeline nodes. */
type ActionCategory = 'observe' | 'setup' | 'drive' | 'communicate' | 'work';

/** Per-elevenex-tool icon + category so each action reads as a product move. */
const ELEVENEX_ACTIONS: Record<string, { icon: string; category: ActionCategory }> = {
  // Observe
  project_overview: { icon: 'lucideLayoutDashboard', category: 'observe' },
  find_sessions: { icon: 'lucideSearch', category: 'observe' },
  session_status: { icon: 'lucideActivity', category: 'observe' },
  read_session: { icon: 'lucideScrollText', category: 'observe' },
  text_search: { icon: 'lucideSearch', category: 'observe' },
  file_search: { icon: 'lucideSearch', category: 'observe' },
  read_file: { icon: 'lucideFileText', category: 'observe' },
  change_review: { icon: 'lucideGitCompare', category: 'observe' },
  get_worktree_context: { icon: 'lucideInfo', category: 'observe' },
  await_session_event: { icon: 'lucideClock', category: 'observe' },
  assess_worktree_pool: { icon: 'lucideLayers', category: 'observe' },
  // Setup
  find_or_create_project: { icon: 'lucideFolderPlus', category: 'setup' },
  add_repo: { icon: 'lucideGitFork', category: 'setup' },
  remove_repo: { icon: 'lucideFolderMinus', category: 'setup' },
  create_worktree: { icon: 'lucideGitBranch', category: 'setup' },
  get_worktree_job: { icon: 'lucideClock', category: 'setup' },
  link_worktree: { icon: 'lucideLink', category: 'setup' },
  steal_worktree: { icon: 'lucideGitBranch', category: 'setup' },
  switch_branch: { icon: 'lucideGitBranch', category: 'setup' },
  generate_worktree_context: { icon: 'lucideFileText', category: 'setup' },
  create_session: { icon: 'lucideTerminal', category: 'setup' },
  set_todo: { icon: 'lucideListChecks', category: 'setup' },
  set_scratchpad: { icon: 'lucidePencil', category: 'setup' },
  // Drive
  prompt_session: { icon: 'lucideSend', category: 'drive' },
  ask_session: { icon: 'lucideMessageCircle', category: 'drive' },
  interrupt_session: { icon: 'lucideSquare', category: 'drive' },
  fork_session: { icon: 'lucideGitFork', category: 'drive' },
  archive_session: { icon: 'lucideArchive', category: 'drive' },
  reset_session: { icon: 'lucideRotateCcw', category: 'drive' },
  get_pending_action: { icon: 'lucideBell', category: 'drive' },
  resolve_action: { icon: 'lucideCheck', category: 'drive' },
  set_provider: { icon: 'lucideCpu', category: 'drive' },
  set_model: { icon: 'lucideCpu', category: 'drive' },
  set_permission_mode: { icon: 'lucideShieldCheck', category: 'drive' },
  // Communicate
  notify_user: { icon: 'lucideBell', category: 'communicate' },
  show_user: { icon: 'lucidePresentation', category: 'communicate' },
  request_approval: { icon: 'lucideShieldCheck', category: 'communicate' },
  escalate_to_user: { icon: 'lucideTriangleAlert', category: 'communicate' },
};

export interface ConversationRow {
  id: string;
  type: 'message' | 'thinking' | 'action' | 'error' | 'show';
  kind?: ClaudeTranscriptItem['kind'];
  content?: string;
  // action
  icon?: string;
  verb?: string;
  target?: string;
  category?: ActionCategory;
  status?: 'pending' | 'ok' | 'error';
  result?: ResultSummary | null;
  detail?: string;
  output?: string;
  toolUseId?: string;
  // show
  show?: AgentShow;
  timestamp: string;
}

/**
 * A turn's folded work — tool calls, thinking, and intermediate assistant
 * messages — that collapses to a pill when idle. `actionCount` counts only the
 * tool calls (the "steps"); folded thinking/messages do not add to it.
 */
export interface ClusterGroup {
  type: 'cluster';
  id: string;
  rows: ConversationRow[];
  actionCount: number;
  durationLabel: string;
  /** LLM-authored one-liner describing what the agent did, when available. */
  summary: string | null;
}

interface SingleGroup {
  type: 'single';
  id: string;
  row: ConversationRow;
}

export type TimelineGroup = ClusterGroup | SingleGroup;

export function buildMissionRows(
  items: readonly ClaudeTranscriptItem[],
  shows: readonly AgentShow[],
): ConversationRow[] {
  const resultByToolUse = new Map<string, ClaudeTranscriptItem>();
  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      resultByToolUse.set(item.toolUseId, item);
    }
  }

  const rows: ConversationRow[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'user':
      case 'assistant': {
        const content = (item.content ?? '').trim();
        if (!content) break;
        rows.push({
          id: item.id,
          type: 'message',
          kind: item.kind,
          content,
          timestamp: item.timestamp,
        });
        break;
      }
      case 'thinking': {
        const content = (item.content ?? '').trim();
        if (!content) break;
        rows.push({
          id: item.id,
          type: 'thinking',
          kind: item.kind,
          content,
          timestamp: item.timestamp,
        });
        break;
      }
      case 'error': {
        rows.push({
          id: item.id,
          type: 'error',
          content: (item.content ?? 'Something went wrong.').trim(),
          timestamp: item.timestamp,
        });
        break;
      }
      case 'tool_use': {
        if (shouldHideToolCall(item.toolName, item.toolInput, item.toolKind)) {
          break;
        }
        const view = describeAgentTool(item);
        const meta = actionMeta(item);
        const result = item.toolUseId ? resultByToolUse.get(item.toolUseId) : undefined;
        const status: ConversationRow['status'] = !result
          ? 'pending'
          : result.isError
            ? 'error'
            : 'ok';
        const output = result ? contentToString(result.content).trim() : '';
        const detail = detailFor(item.toolInput);
        rows.push({
          id: item.id,
          type: 'action',
          kind: item.kind,
          icon: meta.icon ?? view.icon,
          verb: view.verb,
          target: view.target,
          category: meta.category,
          status,
          result: result
            ? resultSummary(view.kind, { content: result.content, isError: result.isError })
            : null,
          detail,
          output,
          toolUseId: item.toolUseId,
          timestamp: item.timestamp,
        });
        break;
      }
      default:
        break;
    }
  }

  for (const show of shows) {
    rows.push({
      id: `show-${show.id}`,
      type: 'show',
      show,
      timestamp: show.createdAt,
    });
  }

  rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return rows;
}

export function buildMissionGroups(
  rows: readonly ConversationRow[],
  summaries: readonly ClaudeToolUseSummary[],
): TimelineGroup[] {
  // Pre-mark the last assistant message of each turn so it renders inline as
  // the visible reply while earlier assistant messages fold into the cluster.
  const finalAssistantIds = new Set<string>();
  let lastAssistant: ConversationRow | null = null;
  for (const row of rows) {
    if (row.type === 'message' && row.kind === 'user') {
      if (lastAssistant) finalAssistantIds.add(lastAssistant.id);
      lastAssistant = null;
    } else if (row.type === 'message' && row.kind === 'assistant') {
      lastAssistant = row;
    }
  }
  if (lastAssistant) finalAssistantIds.add(lastAssistant.id);

  const out: TimelineGroup[] = [];
  let cluster: ClusterGroup | null = null;
  const toolIds: string[] = [];

  const flush = () => {
    if (!cluster) return;
    cluster.summary = summaryFor(toolIds, summaries);
    cluster.durationLabel = spanLabel(
      cluster.rows[0]?.timestamp,
      cluster.rows[cluster.rows.length - 1]?.timestamp,
    );
    out.push(cluster);
    cluster = null;
    toolIds.length = 0;
  };

  for (const row of rows) {
    const isFinalReply =
      row.type === 'message' && row.kind === 'assistant' && finalAssistantIds.has(row.id);
    // Fold the turn's tool calls, thinking, and intermediate assistant
    // messages. Everything else — user prompts, the final reply, shows and
    // errors — stays inline and ends the current cluster.
    const foldable =
      row.type === 'action' ||
      row.type === 'thinking' ||
      (row.type === 'message' && row.kind === 'assistant' && !isFinalReply);

    if (foldable) {
      if (!cluster) {
        cluster = {
          type: 'cluster',
          id: `cluster-${row.id}`,
          rows: [],
          actionCount: 0,
          durationLabel: '',
          summary: null,
        };
      }
      cluster.rows.push(row);
      if (row.type === 'action') {
        cluster.actionCount += 1;
        if (row.toolUseId) toolIds.push(row.toolUseId);
      }
    } else {
      flush();
      out.push({ type: 'single', id: row.id, row });
    }
  }
  flush();
  return out;
}

// --- helpers --------------------------------------------------------------

/** Resolve the elevenex tool name → icon + category, else a neutral "work". */
function actionMeta(item: ClaudeTranscriptItem): {
  icon: string | null;
  category: ActionCategory;
} {
  const tool = elevenexToolName(item);
  if (tool && ELEVENEX_ACTIONS[tool]) {
    return ELEVENEX_ACTIONS[tool];
  }
  return { icon: null, category: 'work' };
}

function elevenexToolName(item: ClaudeTranscriptItem): string | null {
  const raw = item.toolName || item.providerToolName || '';
  const parts = raw.split('__');
  if (parts.length >= 3 && parts[1] === 'elevenex') {
    return parts.slice(2).join('__');
  }
  const data = item.toolInput as Record<string, unknown> | undefined;
  if (data && data['server'] === 'elevenex' && typeof data['tool'] === 'string') {
    return data['tool'];
  }
  return null;
}

/** Latest LLM tool-use summary that covers any of the cluster's tool ids. */
function summaryFor(toolIds: string[], summaries: readonly ClaudeToolUseSummary[]): string | null {
  if (!toolIds.length || !summaries.length) return null;
  const set = new Set(toolIds);
  for (let i = summaries.length - 1; i >= 0; i--) {
    const s = summaries[i];
    if (s.precedingToolUseIds?.some((id) => set.has(id))) {
      return s.summary?.trim() || null;
    }
  }
  return null;
}

/** Human label for the elapsed span between two ISO timestamps. */
function spanLabel(start?: string, end?: string): string {
  if (!start || !end) return '';
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms) || ms < 1000) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** A compact, readable summary of the tool input for the expanded view. */
function detailFor(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
