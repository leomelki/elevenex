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
    normalized === 'filereadtool' ||
    normalized === 'readfile' ||
    normalized === 'readmanyfiles'
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
    normalized === 'writefile' ||
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
    normalized === 'runshellcommand' ||
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
        command:
          typeof data['command'] === 'string'
            ? stripShellCommandWrapper(data['command'])
            : '',
      },
    };
  }

  if (normalized === 'grep' || normalized === 'searchfilecontent') {
    return { toolKind: 'grep', toolDisplayName: 'Grep', toolInput: data };
  }

  if (normalized === 'glob') {
    return { toolKind: 'glob', toolDisplayName: 'Glob', toolInput: data };
  }

  // A directory listing produces the same shape of result as a glob (a set of
  // paths), so it reuses that card rather than falling through to `unknown`.
  if (normalized === 'listdirectory' || normalized === 'ls') {
    return { toolKind: 'glob', toolDisplayName: 'List', toolInput: data };
  }

  if (normalized === 'webfetch') {
    return {
      toolKind: 'web_fetch',
      toolDisplayName: 'WebFetch',
      toolInput: data,
    };
  }

  if (normalized === 'websearch' || normalized === 'googlewebsearch') {
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

  if (normalized === 'todowrite' || normalized === 'writetodos') {
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

/**
 * Removes a shell executable and its command-string switch from the command
 * shown in a run tool. The provider input remains untouched, so transcripts
 * retain the exact command that was executed.
 *
 * This intentionally recognizes only command-string invocation forms. A shell
 * used to run a script file or passed unrelated flags is still shown verbatim.
 */
export function stripShellCommandWrapper(command: string): string {
  const parsed = splitExecutable(command);
  if (!parsed) return command;

  const executable = parsed.executable
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.toLowerCase();
  if (!executable) return command;

  let payload: string | null = null;
  if (
    executable === 'powershell' ||
    executable === 'powershell.exe' ||
    executable === 'pwsh' ||
    executable === 'pwsh.exe'
  ) {
    const match = parsed.rest.match(
      /^(?:(?:-NoLogo|-NoProfile|-NonInteractive|-MTA|-STA)\s+)*(?:-Command|-c)\s+([\s\S]+)$/i,
    );
    payload = match?.[1] ?? null;
  } else if (
    ['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish'].includes(executable)
  ) {
    const match = parsed.rest.match(/^-(?:c|lc|cl)\s+([\s\S]+)$/);
    payload = match?.[1] ?? null;
  } else if (executable === 'cmd' || executable === 'cmd.exe') {
    const match = parsed.rest.match(/^(?:(?:\/d|\/s)\s+)*\/c\s+([\s\S]+)$/i);
    payload = match?.[1] ?? null;
  }

  return payload === null ? command : unwrapOuterQuotes(payload.trim());
}

function splitExecutable(
  command: string,
): { executable: string; rest: string } | null {
  const trimmed = command.trimStart();
  if (!trimmed) return null;

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end < 0 || !/\s/.test(trimmed[end + 1] ?? '')) return null;
    return {
      executable: trimmed.slice(1, end),
      rest: trimmed.slice(end + 1).trimStart(),
    };
  }

  const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  return match ? { executable: match[1], rest: match[2] } : null;
}

function unwrapOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return value;
  }

  for (let index = 1; index < value.length - 1; index++) {
    if (value[index] !== quote) continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const character = value[cursor];
      if (character !== '\\' && character !== '`') break;
      escapes++;
    }
    if (escapes % 2 === 0) return value;
  }

  return value.slice(1, -1);
}

function stringField(data: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
