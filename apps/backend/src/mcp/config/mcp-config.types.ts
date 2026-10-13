import type { McpScope, McpServerEntry, McpSnapshot } from '../mcp.types.js';

export type McpProvider = 'claude' | 'codex' | 'opencode' | 'pi';
export type McpEditableScope = 'project' | 'user' | 'local';

/** Provider-neutral editor values. Native options outside these fields are preserved. */
export interface McpServerDefinition {
  name: string;
  scope: McpEditableScope;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  revision?: string;
  /** Additional JSON-compatible native fields supplied by a configuration import. */
  nativeOptions?: Record<string, unknown>;
}

export interface McpManagedEntry extends McpServerEntry {
  endpoint?: string;
  revision?: string;
  shadowed?: boolean;
  actions: McpServerEntry['actions'] & { canEdit: boolean; canRemove: boolean };
}

export interface McpManagedSnapshot extends Omit<McpSnapshot, 'servers'> {
  servers: McpManagedEntry[];
  provider: McpProvider;
  availableScopes: McpEditableScope[];
  availableTransports: McpServerDefinition['transport'][];
  notice?: string;
  reloadRequired?: boolean;
}

export interface McpConfigSource {
  path: string;
  scope: McpScope;
  format: 'json' | 'jsonc' | 'toml';
  serverPath: string[];
  writable: boolean;
}

export type McpConfigRecord = Record<string, unknown>;

export function record(value: unknown): McpConfigRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as McpConfigRecord)
    : null;
}

export function atPath(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => record(value)?.[key], root);
}

export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item: unknown): item is string => typeof item === 'string')
    : [];
}
