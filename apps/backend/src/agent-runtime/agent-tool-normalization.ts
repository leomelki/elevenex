import type { AgentToolKind } from '../claude-runtime/claude-runtime.types.js';

export interface CanonicalAgentTool {
  toolKind: AgentToolKind;
  toolDisplayName: string;
  toolInput: unknown;
}

type JsonRecord = Record<string, unknown>;

export function normalizeToolName(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/[_\-\s]/g, '');
}

export function asRecord(input: unknown): JsonRecord {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as JsonRecord)
    : {};
}

export function commandActions(input: unknown): unknown[] {
  const data = asRecord(input);
  const camel = data['commandActions'];
  if (Array.isArray(camel)) return camel;
  const snake = data['command_actions'];
  return Array.isArray(snake) ? snake : [];
}

export function readActionPath(input: unknown): string | null {
  const action = commandActions(input)
    .map(asRecord)
    .find((entry) => entry['type'] === 'read');
  if (!action) return null;

  const path = action['path'];
  if (typeof path === 'string' && path.trim()) return path;

  const name = action['name'];
  return typeof name === 'string' && name.trim() ? name : null;
}

export function canonicalizeAgentTool(
  toolName: string | undefined,
  input: unknown,
): CanonicalAgentTool {
  const data = asRecord(input);
  const rawName = toolName || 'Tool';
  const normalized = normalizeToolName(rawName);

  if (
    normalized === 'read' ||
    normalized === 'fileread' ||
    normalized === 'filereadtool'
  ) {
    return {
      toolKind: 'read',
      toolDisplayName: 'Read',
      toolInput: { ...data, file_path: stringField(data, 'file_path', 'path') },
    };
  }

  if (
    normalized === 'write' ||
    normalized === 'filewrite' ||
    normalized === 'filewritetool' ||
    normalized === 'create'
  ) {
    return {
      toolKind: 'write',
      toolDisplayName: data['old_string'] === '' ? 'Create' : 'Write',
      toolInput: { ...data, file_path: stringField(data, 'file_path', 'path') },
    };
  }

  if (
    normalized === 'edit' ||
    normalized === 'multiedit' ||
    normalized === 'fileedit' ||
    normalized === 'fileedittool' ||
    normalized === 'strreplace' ||
    normalized === 'strreplacebasededittool' ||
    normalized === 'strreplacebasedeittool'
  ) {
    return {
      toolKind: 'edit',
      toolDisplayName: 'Edit',
      toolInput: { ...data, file_path: stringField(data, 'file_path', 'path') },
    };
  }

  if (normalized === 'notebookedit') {
    return {
      toolKind: 'notebook_edit',
      toolDisplayName: 'Edit notebook',
      toolInput: data,
    };
  }

  if (
    normalized === 'bash' ||
    normalized === 'powershell' ||
    normalized === 'shellcommand' ||
    normalized === 'execcommand'
  ) {
    const readPath = readActionPath(input);
    if (readPath) {
      return {
        toolKind: 'read',
        toolDisplayName: 'Read',
        toolInput: {
          ...data,
          file_path: readPath,
          command: typeof data['command'] === 'string' ? data['command'] : '',
        },
      };
    }
    return {
      toolKind: 'bash',
      toolDisplayName: normalized === 'powershell' ? 'PowerShell' : 'Bash',
      toolInput: {
        ...data,
        command: typeof data['command'] === 'string' ? data['command'] : '',
      },
    };
  }

  if (normalized === 'grep') {
    return { toolKind: 'grep', toolDisplayName: 'Grep', toolInput: data };
  }

  if (normalized === 'glob') {
    return { toolKind: 'glob', toolDisplayName: 'Glob', toolInput: data };
  }

  if (normalized === 'webfetch') {
    return {
      toolKind: 'web_fetch',
      toolDisplayName: 'WebFetch',
      toolInput: data,
    };
  }

  if (normalized === 'websearch') {
    return {
      toolKind: 'web_search',
      toolDisplayName: 'WebSearch',
      toolInput: data,
    };
  }

  if (normalized === 'filechanges') {
    return {
      toolKind: 'file_changes',
      toolDisplayName: 'File changes',
      toolInput: data,
    };
  }

  if (
    normalized === 'task' ||
    normalized === 'agent' ||
    normalized === 'agenttool'
  ) {
    return {
      toolKind: 'task_agent',
      toolDisplayName: 'Agent',
      toolInput: data,
    };
  }

  if (normalized === 'todowrite') {
    return {
      toolKind: 'todo_write',
      toolDisplayName: 'Todos',
      toolInput: data,
    };
  }

  if (normalized === 'askuserquestion') {
    return {
      toolKind: 'ask_user_question',
      toolDisplayName: 'Question',
      toolInput: data,
    };
  }

  if (normalized === 'enterplanmode') {
    return {
      toolKind: 'enter_plan_mode',
      toolDisplayName: 'Plan mode',
      toolInput: data,
    };
  }

  if (normalized === 'exitplanmode') {
    return {
      toolKind: 'exit_plan_mode',
      toolDisplayName: 'Plan review',
      toolInput: data,
    };
  }

  if (normalized === 'enterworktree' || normalized === 'exitworktree') {
    return { toolKind: 'worktree', toolDisplayName: rawName, toolInput: data };
  }

  if (normalized === 'lsp' || normalized === 'lsptool') {
    return { toolKind: 'lsp', toolDisplayName: 'LSP', toolInput: data };
  }

  if (normalized === 'skill' || normalized === 'skilltool') {
    return { toolKind: 'skill', toolDisplayName: 'Skill', toolInput: data };
  }

  if (normalized.startsWith('mcp') || typeof data['server'] === 'string') {
    const parts = rawName.split('__');
    const server =
      typeof data['server'] === 'string' ? data['server'] : parts[1];
    const tool = parts.length > 2 ? parts.slice(2).join('.') : rawName;
    return {
      toolKind: 'mcp',
      toolDisplayName: 'MCP',
      toolInput: {
        ...data,
        ...(server ? { server } : {}),
        tool,
      },
    };
  }

  return {
    toolKind: 'unknown',
    toolDisplayName: rawName,
    toolInput: input ?? {},
  };
}

function stringField(data: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
