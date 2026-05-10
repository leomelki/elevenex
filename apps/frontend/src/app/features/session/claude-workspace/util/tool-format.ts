import type { ClaudeToolInteractionSummary } from '@/shared/models/claude-runtime.model';

// Tool-aware display metadata — mirrors how Claude Code renders tool use/results
// (see /Users/leo.melki/Documents/claude-code/src/tools/*/UI.tsx).
//
// Each tool produces:
//  - icon       : lucide icon name
//  - verb       : short human verb ("Read", "Edit", "Run", "Search"…)
//  - target     : one-line inline descriptor (file path / command / pattern / url)
//  - resultSummary : terse result line when completed ("52 lines", "3 matches", "exit 0")

export type ToolKind =
  | 'ask_user_question'
  | 'read'
  | 'edit'
  | 'write'
  | 'notebook_edit'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'web_fetch'
  | 'web_search'
  | 'file_changes'
  | 'task_agent'
  | 'todo_write'
  | 'plan_mode'
  | 'exit_plan_mode'
  | 'worktree'
  | 'lsp'
  | 'skill'
  | 'mcp'
  | 'unknown';

export interface ToolDisplay {
  kind: ToolKind;
  icon: string;
  verb: string;
  target: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function basename(path: string | undefined): string {
  if (!path) return '';
  const clean = path.split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || path;
}

export function displayPath(path: string | undefined): string {
  if (!path) return '';
  // Try to shorten to last two segments for long absolute paths
  const parts = path.split('/');
  if (parts.length > 4) {
    return '…/' + parts.slice(-3).join('/');
  }
  return path;
}

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

export function describeTool(toolName: string | undefined, input: unknown): ToolDisplay {
  const data = asRecord(input);
  const name = toolName || 'Tool';
  const n = normalizeToolName(name);

  // File read
  if (n === 'read' || n === 'fileread' || n === 'filereadtool') {
    const p = data['file_path'] as string | undefined;
    return { kind: 'read', icon: 'lucideFileText', verb: 'Read', target: displayPath(p || '') };
  }
  if (n === 'askuserquestion') {
    const questions = Array.isArray(data['questions']) ? data['questions'] : [];
    const firstQuestion = asRecord(questions[0]);
    const questionText =
      typeof firstQuestion['question'] === 'string'
        ? firstQuestion['question']
        : '';
    const extraCount = Math.max(questions.length - 1, 0);
    return {
      kind: 'ask_user_question',
      icon: 'lucideSparkles',
      verb: 'Question',
      target:
        questionText
          ? truncate(
              extraCount > 0
                ? `${questionText} +${extraCount} more`
                : questionText,
              120,
            )
          : '',
    };
  }
  // File write
  if (n === 'write' || n === 'filewrite' || n === 'filewritetool') {
    const p = data['file_path'] as string | undefined;
    const isCreate = !('old_string' in data);
    return {
      kind: 'write',
      icon: 'lucideFilePlus',
      verb: isCreate ? 'Create' : 'Write',
      target: displayPath(p || ''),
    };
  }
  // Edit / MultiEdit
  if (n === 'edit' || n === 'multiedit' || n === 'fileedit' || n === 'fileedittool') {
    const p = data['file_path'] as string | undefined;
    const edits = data['edits'];
    const verb = Array.isArray(edits) && edits.length > 1 ? 'Edit' : (data['old_string'] === '' ? 'Create' : 'Edit');
    return { kind: 'edit', icon: 'lucideFilePen', verb, target: displayPath(p || '') };
  }
  // Notebook edit
  if (n === 'notebookedit') {
    const p = data['notebook_path'] as string | undefined;
    return { kind: 'notebook_edit', icon: 'lucideFilePen', verb: 'Edit notebook', target: displayPath(p || '') };
  }
  // Bash / PowerShell
  if (n === 'bash' || n === 'powershell') {
    const cmd = String(data['command'] ?? '').trim();
    const firstLine = cmd.split('\n')[0] || cmd;
    return { kind: 'bash', icon: 'lucideTerminal', verb: 'Run', target: truncate(firstLine, 120) };
  }
  // Grep
  if (n === 'grep') {
    const pattern = String(data['pattern'] ?? '');
    const path = data['path'] as string | undefined;
    const target = path ? `${pattern} in ${displayPath(path)}` : pattern;
    return { kind: 'grep', icon: 'lucideSearch', verb: 'Search', target: truncate(target, 100) };
  }
  // Glob
  if (n === 'glob') {
    const pattern = String(data['pattern'] ?? '');
    return { kind: 'glob', icon: 'lucideSearch', verb: 'Find', target: truncate(pattern, 100) };
  }
  // WebFetch
  if (n === 'webfetch') {
    return { kind: 'web_fetch', icon: 'lucideGlobe', verb: 'Fetch', target: truncate(String(data['url'] ?? ''), 100) };
  }
  // WebSearch
  if (n === 'websearch') {
    return { kind: 'web_search', icon: 'lucideGlobe', verb: 'Search web', target: truncate(String(data['query'] ?? ''), 100) };
  }
  if (n === 'filechanges') {
    const changes = Array.isArray(data['changes']) ? data['changes'] : [];
    const first = asRecord(changes[0]);
    const path = String(first['path'] ?? '');
    const suffix = changes.length > 1 ? ` +${changes.length - 1}` : '';
    return {
      kind: 'file_changes',
      icon: 'lucideFilePen',
      verb: 'Change files',
      target: path ? `${displayPath(path)}${suffix}` : `${changes.length} file${changes.length === 1 ? '' : 's'}`,
    };
  }
  // Task / Agent (subagent dispatch)
  if (n === 'task' || n === 'agent' || n === 'agenttool') {
    const subagent = String(data['subagent_type'] ?? '').trim();
    const description = String(data['description'] ?? '').trim();
    const verb = subagent && subagent !== 'general-purpose' ? subagent : 'Agent';
    return { kind: 'task_agent', icon: 'lucideUsers', verb, target: truncate(description, 120) };
  }
  if (n === 'sendmessage') {
    const message = asRecord(data['message']);
    if (message['type'] === 'plan_approval_response') {
      const approve = message['approve'] === true;
      const target = String(data['to'] ?? '');
      return {
        kind: 'unknown',
        icon: 'lucideUsers',
        verb: approve ? 'Approve plan' : 'Reject plan',
        target,
      };
    }
  }
  // TodoWrite
  if (n === 'todowrite') {
    const todos = Array.isArray(data['todos']) ? (data['todos'] as unknown[]).length : 0;
    const inProgress = Array.isArray(data['todos'])
      ? (data['todos'] as Array<Record<string, unknown>>).find((t) => t['status'] === 'in_progress')
      : null;
    const current = inProgress?.['content'];
    return {
      kind: 'todo_write',
      icon: 'lucideListTodo',
      verb: 'Todos',
      target: current ? truncate(String(current), 100) : `${todos} item${todos === 1 ? '' : 's'}`,
    };
  }
  // Plan mode
  if (n === 'enterplanmode') return { kind: 'plan_mode', icon: 'lucideMap', verb: 'Plan mode', target: 'Entered' };
  if (n === 'exitplanmode') return { kind: 'exit_plan_mode', icon: 'lucideMap', verb: 'Plan review', target: '' };
  // Worktree
  if (n === 'enterworktree') return { kind: 'worktree', icon: 'lucideGitBranch', verb: 'Enter worktree', target: '' };
  if (n === 'exitworktree') return { kind: 'worktree', icon: 'lucideGitBranch', verb: 'Exit worktree', target: '' };
  // LSP
  if (n === 'lsp' || n === 'lsptool') {
    const op = String(data['operation'] ?? data['method'] ?? '');
    return { kind: 'lsp', icon: 'lucideBraces', verb: 'LSP', target: op };
  }
  // Skill
  if (n === 'skill' || n === 'skilltool') {
    const skill = String(data['skill'] ?? '');
    return { kind: 'skill', icon: 'lucideSparkles', verb: 'Skill', target: skill };
  }
  // MCP
  if (n.startsWith('mcp') || typeof data['server'] === 'string') {
    const parts = name.split('__');
    const server = String(data['server'] ?? parts[1] ?? '');
    const tool = parts.length > 2 ? parts.slice(2).join('.') : name;
    return { kind: 'mcp', icon: 'lucidePlugZap', verb: server || 'MCP', target: tool };
  }

  // Fallback: pick first string-ish value as target
  let target = '';
  for (const value of Object.values(data)) {
    if (typeof value === 'string' && value.trim()) {
      target = truncate(value, 100);
      break;
    }
  }
  return { kind: 'unknown', icon: 'lucideSparkles', verb: name, target };
}

export function isPlanArtifactPath(path: string | undefined): boolean {
  if (!path) return false;
  return /(^|\/)\.claude\/plans(\/|$)/.test(path.replace(/\\/g, '/'));
}

export function shouldHideToolCall(toolName: string | undefined, input: unknown): boolean {
  const data = asRecord(input);
  const n = normalizeToolName(toolName || '');

  if (
    n === 'toolsearch' ||
    n === 'taskcreate' ||
    n === 'taskupdate' ||
    n === 'tasklist' ||
    n === 'taskget' ||
    n === 'taskstop' ||
    n === 'taskoutput'
  ) {
    return true;
  }

  if ((n === 'write' || n === 'filewrite' || n === 'filewritetool') && isPlanArtifactPath(data['file_path'] as string | undefined)) {
    return true;
  }

  if ((n === 'edit' || n === 'multiedit' || n === 'fileedit' || n === 'fileedittool') && isPlanArtifactPath(data['file_path'] as string | undefined)) {
    return true;
  }

  if (n === 'sendmessage') {
    const message = data['message'];
    if (!message || typeof message !== 'object') return true;
    const messageType = (message as Record<string, unknown>)['type'];
    return messageType !== 'plan_approval_response';
  }

  return false;
}

// ---------- Result summaries ----------

export interface ResultSummary {
  text: string;
  tone: 'neutral' | 'ok' | 'warn' | 'error';
}

// True tool errors are wrapped by Claude in <tool_use_error>…</tool_use_error>.
// The SDK's `isError` flag is set any time `is_error: true` comes back — which
// happens for legitimate non-zero exits too (e.g. `ls --bad-flag` prints the
// directory then exits 2). We only treat wrapped errors as hard errors.
export function isHardError(result: { content?: unknown; isError?: boolean } | null): boolean {
  if (!result) return false;
  if (!result.isError) return false;
  const text = contentToString(result.content);
  return /<tool_use_error>/i.test(text);
}

export function extractToolError(text: string): string {
  const m = text.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i);
  return (m ? m[1] : text).trim();
}

export function resultSummary(
  kind: ToolKind,
  result: { content?: unknown; isError?: boolean } | null,
  interaction?: ClaudeToolInteractionSummary | null,
): ResultSummary | null {
  if (interaction) {
    return {
      text: interaction.decisionLabel,
      tone: interaction.decisionTone,
    };
  }
  if (!result) return null;
  const text = contentToString(result.content).trim();

  if (isHardError(result)) {
    const first = extractToolError(text).split('\n').find((l) => l.trim()) ?? 'Error';
    return { text: truncate(first || 'Error', 100), tone: 'error' };
  }

  // Soft "isError" (e.g. non-zero bash exit with real output) — render the
  // normal per-tool summary but nudge the tone to warn.
  const soft = !!result.isError;
  const softTone = (t: ResultSummary['tone']): ResultSummary['tone'] =>
    soft && t === 'ok' ? 'warn' : t;

  switch (kind) {
    case 'read': {
      const lines = countLines(text);
      if (lines === 0 && text.length === 0) return { text: '', tone: 'neutral' };
      return { text: `${lines} ${lines === 1 ? 'line' : 'lines'}`, tone: softTone('ok') };
    }
    case 'write': {
      const lines = countLines(text);
      return { text: lines ? `Wrote ${lines} lines` : 'Wrote', tone: softTone('ok') };
    }
    case 'edit':
    case 'notebook_edit':
      return { text: 'Updated', tone: softTone('ok') };
    case 'bash': {
      const lines = countLines(text);
      if (lines === 0) return { text: soft ? 'Non-zero exit' : 'Done', tone: softTone('ok') };
      const base = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
      return { text: soft ? `${base} · non-zero exit` : `${base} of output`, tone: softTone('ok') };
    }
    case 'grep': {
      const m = text.match(/Found\s+(\d+)\s+(match|matches)/i);
      if (m) return { text: `${m[1]} ${m[2]}`, tone: softTone('ok') };
      const noMatch = /no matches|no results|found 0/i.test(text);
      if (noMatch) return { text: 'No matches', tone: 'warn' };
      const lineCount = countNonEmptyLines(text);
      return { text: `${lineCount} match${lineCount === 1 ? '' : 'es'}`, tone: softTone('ok') };
    }
    case 'glob': {
      const lineCount = countNonEmptyLines(text);
      if (!lineCount) return { text: 'No files', tone: 'warn' };
      return { text: `${lineCount} file${lineCount === 1 ? '' : 's'}`, tone: softTone('ok') };
    }
    case 'web_fetch':
      return { text: soft ? 'Fetch warning' : 'Fetched', tone: softTone('ok') };
    case 'web_search': {
      const lineCount = countNonEmptyLines(text);
      return {
        text: `${lineCount || 'some'} result${lineCount === 1 ? '' : 's'}`,
        tone: softTone('ok'),
      };
    }
    case 'task_agent':
      return { text: 'Done', tone: softTone('ok') };
    case 'todo_write':
      return { text: '', tone: 'neutral' };
    case 'ask_user_question': {
      const parsed = parseJsonRecord(text);
      const answers = parsed && parsed['answers'] && typeof parsed['answers'] === 'object'
        ? Object.keys(parsed['answers'] as Record<string, unknown>).length
        : 0;
      return { text: `${answers || 'Answered'} question${answers === 1 ? '' : 's'}`, tone: softTone('ok') };
    }
    case 'plan_mode':
      return { text: 'Entered', tone: softTone('ok') };
    case 'exit_plan_mode': {
      const parsed = parseJsonRecord(text);
      const awaitingLeaderApproval = parsed?.['awaitingLeaderApproval'] === true;
      if (awaitingLeaderApproval) return { text: 'Awaiting approval', tone: 'warn' };
      return { text: 'Plan approved', tone: softTone('ok') };
    }
    default: {
      if (!text) return { text: 'Done', tone: softTone('ok') };
      const first = text.split('\n').find((l) => l.trim()) ?? '';
      return { text: truncate(first, 80), tone: soft ? 'warn' : 'neutral' };
    }
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  // Trailing newline doesn't add a new line
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function countNonEmptyLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter((l) => l.trim()).length;
}

export function contentToString(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in (p as Record<string, unknown>)) {
          return String((p as Record<string, unknown>)['text'] ?? '');
        }
        try {
          return JSON.stringify(p, null, 2);
        } catch {
          return String(p);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
