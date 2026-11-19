import type { SessionChatRecord } from './session-chat';

type Tool = Pick<SessionChatRecord, 'toolKind' | 'toolName'>;
type Result = Pick<SessionChatRecord, 'text' | 'error' | 'execution' | 'truncated'>;

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
}

function text(data: Readonly<Record<string, unknown>>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The collapsed row uses the same heading for inline evidence and deferred references. */
export function sessionChatToolHeading(tool: Tool, decodedInput: unknown, result?: Result, output?: unknown) {
  const input = object(decodedInput);
  const path = text(input, 'file_path', 'path', 'filePath', 'notebook_path');
  const defaultTitle = text(input, 'description', 'title', 'query', 'pattern', 'url', 'file_path', 'path') ||
    tool.toolName || 'Tool';
  let summary = defaultTitle;
  let meta = '';
  let exit: string | number | undefined;
  switch (tool.toolKind) {
    case 'bash': {
      const command = text(input, 'command', 'cmd', 'input') ||
        (typeof decodedInput === 'string' ? decodedInput : '');
      summary = command.slice(0, 500).split('\n')[0] || defaultTitle;
      const data = object(output);
      const reported = result?.execution?.exitCode ?? data['exit_code'] ?? data['exitCode'] ??
        result?.text.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/i)?.[1];
      if (typeof reported === 'number' || typeof reported === 'string') exit = reported;
      if (result?.execution?.interrupted) meta = 'Interrupted';
      else if (exit !== undefined) meta = `Exit ${exit}`;
      break;
    }
    case 'read':
    case 'write':
    case 'edit':
      summary = path || defaultTitle;
      break;
    case 'file_changes': {
      const count = list(input['changes']).length;
      summary = count ? `${count} ${count === 1 ? 'file' : 'files'}` : path || 'File changes';
      break;
    }
    case 'notebook_edit':
      summary = path || 'Notebook cell';
      break;
    case 'grep':
    case 'glob':
      summary = text(input, 'pattern', 'query', 'path') || 'Repository search';
      if (tool.toolKind === 'glob' && typeof output === 'string' && !result?.error) {
        const count = output.trim().split('\n').filter(Boolean).length;
        if (count) meta = `${count}${result?.truncated ? '+' : ''} paths`;
      }
      break;
    case 'web_search':
    case 'web_fetch':
      summary = text(input, 'query', 'url', 'search_term') || text(object(input['action']), 'url', 'pattern') ||
        text(object(list(input['queries'])[0]), 'q', 'query') || 'Web search';
      break;
    case 'todo_write': {
      const todos = list(input['todos'] ?? input['items'] ?? input['plan']);
      const done = todos.filter(value => {
        const todo = object(value);
        return todo['completed'] === true || ['completed', 'done', 'success'].some(status => status === todo['status']);
      }).length;
      summary = todos.length ? `${done} of ${todos.length} complete` : 'Update plan';
      break;
    }
    case 'task_agent':
    case 'agent_collaboration':
      summary = text(input, 'description', 'task_name', 'target', 'agent_id') || tool.toolName || 'Agent';
      break;
    case 'ask_user_question':
      summary = text(object(list(input['questions'])[0]), 'question', 'header', 'title') || 'Question';
      break;
    case 'enter_plan_mode':
      summary = 'Enter plan mode';
      break;
    case 'exit_plan_mode':
      summary = 'Review plan';
      break;
    case 'worktree':
      summary = text(input, 'name', 'branch', 'path') || tool.toolName || 'Workspace';
      break;
    case 'lsp':
      summary = text(input, 'operation', 'method') || 'Code intelligence';
      break;
    case 'skill':
      summary = text(input, 'skill', 'name') || 'Skill';
      break;
    case 'mcp': {
      const name = text(input, 'tool');
      summary = name ? name.replace(/^mcp__[^_]+__/, '').replace(/\./g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
        .replace(/\b(?:url|uri|id|cwd)\b/gi, value => value === 'cwd' ? 'Working directory' : value.toUpperCase())
        .replace(/^./, value => value.toUpperCase()) : tool.toolName || 'Connected tool';
      meta = text(input, 'server');
      break;
    }
  }
  return { summary: summary.slice(0, 500), ...(meta ? { meta: meta.slice(0, 100) } : {}), exit };
}
