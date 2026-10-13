import { homedir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  record,
  type McpConfigSource,
  type McpProvider,
  type McpServerDefinition,
  type McpConfigRecord,
} from './mcp-config.types.js';

const connectionFields = [
  'type',
  'command',
  'args',
  'env',
  'environment',
  'url',
  'headers',
  'http_headers',
  'enabled',
  'disabled',
];

/** Preserve native imports without letting unvalidated fields replace the
 * normalized connection, or accepting values the JSON/TOML writers cannot store. */
function validateNativeOptions(options: unknown): void {
  if (
    !record(options) ||
    Object.keys(options as object).some((key) => connectionFields.includes(key))
  )
    throw new BadRequestException(
      'Native options must be an object containing only additional server settings.',
    );
  const visit = (value: unknown, depth: number): void => {
    if (depth > 20)
      throw new BadRequestException('Native options are nested too deeply.');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (record(value)) {
      for (const [key, item] of Object.entries(value as McpConfigRecord)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new BadRequestException(
            'Native options contain a reserved key.',
          );
        visit(item, depth + 1);
      }
    } else
      throw new BadRequestException(
        'Native options must contain JSON-compatible values.',
      );
  };
  visit(options, 0);
  if (Buffer.byteLength(JSON.stringify(options), 'utf8') > 64 * 1024)
    throw new BadRequestException('Native options must be smaller than 64 KB.');
}

/** Source order is precedence order: later definitions override earlier ones. */
export function configSources(
  provider: McpProvider,
  cwd: string,
): McpConfigSource[] {
  const json = (
    path: string,
    scope: McpConfigSource['scope'],
    serverPath = ['mcpServers'],
    writable = true,
  ): McpConfigSource => ({
    path,
    scope,
    serverPath,
    writable,
    format: provider === 'opencode' ? 'jsonc' : 'json',
  });
  switch (provider) {
    case 'claude': {
      const global = join(
        process.env.CLAUDE_CONFIG_DIR || homedir(),
        '.claude.json',
      );
      const managed = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
        ? join(
            process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH,
            'managed-mcp.json',
          )
        : process.platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode/managed-mcp.json'
          : process.platform === 'win32'
            ? 'C:\\Program Files\\ClaudeCode\\managed-mcp.json'
            : '/etc/claude-code/managed-mcp.json';
      return [
        json(global, 'user'),
        json(join(cwd, '.mcp.json'), 'project'),
        json(global, 'local', ['projects', cwd, 'mcpServers']),
        json(managed, 'enterprise', ['mcpServers'], false),
      ];
    }
    case 'codex':
      return [
        {
          path: join(
            process.env.CODEX_HOME || join(homedir(), '.codex'),
            'config.toml',
          ),
          scope: 'user',
          format: 'toml',
          serverPath: ['mcp_servers'],
          writable: true,
        },
        {
          path: join(cwd, '.codex', 'config.toml'),
          scope: 'project',
          format: 'toml',
          serverPath: ['mcp_servers'],
          writable: true,
        },
      ];
    case 'opencode': {
      const global = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'opencode',
      );
      const sources = [
        json(join(global, 'opencode.json'), 'user', ['mcp']),
        json(join(global, 'opencode.jsonc'), 'user', ['mcp']),
        ...(process.env.OPENCODE_CONFIG
          ? [json(process.env.OPENCODE_CONFIG, 'user', ['mcp'])]
          : []),
        json(join(cwd, 'opencode.json'), 'project', ['mcp']),
        json(join(cwd, 'opencode.jsonc'), 'project', ['mcp']),
        json(join(cwd, '.opencode', 'opencode.json'), 'project', ['mcp']),
        json(join(cwd, '.opencode', 'opencode.jsonc'), 'project', ['mcp']),
        ...(process.env.OPENCODE_CONFIG_DIR
          ? [
              json(
                join(process.env.OPENCODE_CONFIG_DIR, 'opencode.json'),
                'user',
                ['mcp'],
              ),
              json(
                join(process.env.OPENCODE_CONFIG_DIR, 'opencode.jsonc'),
                'user',
                ['mcp'],
              ),
            ]
          : []),
      ];
      // Environment overrides may point at a file already in the standard
      // search list. Keep its highest precedence position and one stable entry.
      const unique = new Map<string, McpConfigSource>();
      for (const source of sources) {
        unique.delete(source.path);
        unique.set(source.path, source);
      }
      return [...unique.values()];
    }
    // Pi has no native MCP client. These files are read by our Pi extension.
    case 'pi':
      return [
        json(
          join(
            process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'),
            'mcp.json',
          ),
          'user',
        ),
        json(join(cwd, '.pi', 'mcp.json'), 'project'),
      ];
  }
}

export function serverPath(
  source: McpConfigSource,
  root: McpConfigRecord,
  provider: McpProvider,
): string[] {
  return provider === 'opencode' &&
    record(root.mcp) &&
    ('servers' in record(root.mcp)! ||
      (record(record(root.mcp)?.timeout) &&
        !('type' in record(record(root.mcp)?.timeout)!)))
    ? ['mcp', 'servers']
    : source.serverPath;
}

export function decodeConfig(
  provider: McpProvider,
  name: string,
  scope: McpServerDefinition['scope'],
  config: McpConfigRecord,
): McpServerDefinition {
  const command = Array.isArray(config.command) ? config.command : undefined;
  return {
    name,
    scope,
    transport:
      typeof config.url === 'string'
        ? config.type === 'sse'
          ? 'sse'
          : 'http'
        : 'stdio',
    command: command
      ? String(command[0] ?? '')
      : typeof config.command === 'string'
        ? config.command
        : '',
    args: command
      ? (command.slice(1) as string[])
      : Array.isArray(config.args)
        ? (config.args as string[])
        : [],
    env:
      (record(
        provider === 'opencode' ? config.environment : config.env,
      ) as Record<string, string>) ?? {},
    url: typeof config.url === 'string' ? config.url : '',
    headers:
      (record(
        provider === 'codex' ? config.http_headers : config.headers,
      ) as Record<string, string>) ?? {},
    enabled:
      config.enabled !== false &&
      (provider === 'codex' || config.disabled !== true),
  };
}

export function encodeConfig(
  provider: McpProvider,
  definition: McpServerDefinition,
  previous: McpConfigRecord = {},
  v2 = false,
): McpConfigRecord {
  const result = { ...previous, ...definition.nativeOptions };
  for (const field of connectionFields) delete result[field];
  if (definition.transport === 'stdio') {
    result.command =
      provider === 'opencode'
        ? [definition.command!, ...(definition.args ?? [])]
        : definition.command;
    if (provider !== 'opencode') result.args = definition.args ?? [];
    result[provider === 'opencode' ? 'environment' : 'env'] =
      definition.env ?? {};
  } else {
    result.url = definition.url;
    result[provider === 'codex' ? 'http_headers' : 'headers'] =
      definition.headers ?? {};
  }
  if (provider === 'opencode')
    result.type = definition.transport === 'stdio' ? 'local' : 'remote';
  else if (provider !== 'codex') result.type = definition.transport;
  if (provider !== 'claude')
    result[v2 ? 'disabled' : 'enabled'] = v2
      ? definition.enabled === false
      : definition.enabled !== false;
  return result;
}

export function validateDefinition(
  value: McpServerDefinition,
  provider: McpProvider,
): McpServerDefinition {
  if (!value || typeof value !== 'object')
    throw new BadRequestException('Provide a server configuration.');
  if (value.nativeOptions !== undefined)
    validateNativeOptions(value.nativeOptions);
  if (
    (value.command !== undefined && typeof value.command !== 'string') ||
    (value.url !== undefined && typeof value.url !== 'string')
  )
    throw new BadRequestException('The command and URL must be strings.');
  if (
    typeof value.name !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.name) ||
    ['__proto__', 'constructor', 'prototype', 'elevenex'].includes(value.name)
  )
    throw new BadRequestException(
      'Use a unique name with letters, numbers, dots, hyphens or underscores. Elevenex is reserved.',
    );
  if (
    !['project', 'user', ...(provider === 'claude' ? ['local'] : [])].includes(
      value.scope,
    )
  )
    throw new BadRequestException('Unsupported configuration scope.');
  if (
    ![
      'stdio',
      'http',
      ...(provider === 'claude' || provider === 'pi' ? ['sse'] : []),
    ].includes(value.transport)
  )
    throw new BadRequestException('Unsupported transport for this agent.');
  if (
    value.transport === 'stdio' &&
    (typeof value.command !== 'string' ||
      !value.command.trim() ||
      /[\r\n\0]/.test(value.command))
  )
    throw new BadRequestException(
      'Enter an executable command. Put each argument in the arguments field.',
    );
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.length > 200 ||
      value.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
  )
    throw new BadRequestException('Arguments must be an array of strings.');
  if (value.transport !== 'stdio') {
    try {
      const url = new URL(value.url!);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      throw new BadRequestException(
        'Enter an HTTP or HTTPS URL without embedded credentials.',
      );
    }
  }
  for (const field of ['env', 'headers'] as const) {
    if (
      value[field] !== undefined &&
      (!record(value[field]) ||
        Object.entries(value[field]).some(
          ([key, item]) =>
            !key.trim() ||
            ['__proto__', 'constructor', 'prototype'].includes(key) ||
            typeof item !== 'string' ||
            /[\r\n\0]/.test(key) ||
            (field === 'headers' && /[\r\n\0]/.test(item)),
        ))
    )
      throw new BadRequestException(
        `${field === 'env' ? 'Environment variables' : 'Headers'} must contain string keys and values.`,
      );
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new BadRequestException('Enabled must be a boolean.');
  return { ...value, command: value.command?.trim(), url: value.url?.trim() };
}
