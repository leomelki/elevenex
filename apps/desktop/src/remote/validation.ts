import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import type { EnvironmentContext, EnvironmentSelection, RemoteForwardInput, RemoteHostInput, WorkspaceViewState } from '@elevenex/shared';

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid remote operation arguments');
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid text argument');
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-zA-Z0-9-]+$/.test(result)) throw new Error('Invalid resource id');
  return result;
}
function port(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (zero ? 0 : 1) || value > 65535) throw new Error('Invalid port');
  return value;
}
export function hostInput(value: unknown): RemoteHostInput {
  const input = object(value, ['name', 'hue', 'host', 'user', 'port', 'identityFile', 'configFile']);
  const host = text(input['host'], 253);
  // Destination also reaches ProxyCommand token expansion in the user's config.
  if (isIP(host) !== 6 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw new Error('Use a hostname or SSH config alias, with user and port in their separate fields');
  const user = input['user'] === undefined ? undefined : text(input['user'], 128);
  if (user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*$/.test(user)) throw new Error('Invalid SSH user');
  const file = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    const result = text(value, 4096);
    if (!isAbsolute(result)) throw new Error('SSH files must use absolute paths');
    return result;
  };
  return {
    name: text(input['name'], 160), host,
    ...(input['hue'] === undefined ? {} : { hue: machineHue(input['hue']) }),
    ...(user === undefined ? {} : { user }),
    ...(input['port'] === undefined ? {} : { port: port(input['port']) }),
    ...(input['identityFile'] === undefined ? {} : { identityFile: file(input['identityFile']) }),
    ...(input['configFile'] === undefined ? {} : { configFile: file(input['configFile']) }),
  };
}
export function machineHue(value: unknown): import('@elevenex/shared').MachineHue {
  if (value === 'ocean' || value === 'pine' || value === 'plum' || value === 'rust' || value === 'steel' || value === 'rose') return value;
  throw new Error('Invalid machine color');
}
export function selection(value: unknown): EnvironmentSelection {
  const input = object(value, ['kind', 'hostId']);
  if (input['kind'] === 'local' && input['hostId'] === undefined) return { kind: 'local' };
  if (input['kind'] === 'remote') return { kind: 'remote', hostId: id(input['hostId']) };
  throw new Error('Invalid environment');
}
export function context(value: unknown): EnvironmentContext {
  const input = object(value, ['projectId', 'taskId', 'sessionId', 'draft', 'cursor', 'workspace']);
  const domainId = (value: unknown): number | null => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid context id');
    return value;
  };
  const draft = input['draft'];
  if (typeof draft !== 'string' || draft.length > 100_000 || draft.includes('\0')) throw new Error('Draft exceeds its limit');
  return { projectId: domainId(input['projectId']), taskId: domainId(input['taskId']), sessionId: domainId(input['sessionId']), draft,
    cursor: input['cursor'] === null ? null : text(input['cursor'], 1024, true),
    ...(input['workspace'] === undefined ? {} : { workspace: workspaceView(input['workspace']) }) };
}
function workspaceView(value: unknown): WorkspaceViewState {
  const input = object(value, ['panel', 'panelOpen', 'wideReview', 'closed', 'focused', 'filter', 'projectCursor', 'taskCursor']);
  const panel = input['panel'], filter = input['filter'];
  if (panel !== 'terminal' && panel !== 'actions' && panel !== 'changes' && panel !== 'code' && panel !== 'browser') throw new Error('Invalid workspace panel');
  if (filter !== null && filter !== 'attention' && filter !== 'running' && filter !== 'review' && filter !== 'done') throw new Error('Invalid workspace filter');
  const flag = (key: string): boolean => {
    const value = input[key];
    if (typeof value !== 'boolean') throw new Error('Invalid workspace flag');
    return value;
  };
  return { panel, filter, panelOpen: flag('panelOpen'), wideReview: flag('wideReview'), closed: flag('closed'), focused: flag('focused'),
    projectCursor: input['projectCursor'] === null ? null : text(input['projectCursor'], 1024),
    taskCursor: input['taskCursor'] === null ? null : text(input['taskCursor'], 1024) };
}
export function forward(value: unknown): RemoteForwardInput {
  const input = object(value, ['remotePort', 'localPort', 'label']);
  const localPort = port(input['localPort'], true);
  if (localPort !== 0 && localPort < 1024) throw new Error('Use an unprivileged local port or 0 for automatic allocation');
  return { remotePort: port(input['remotePort']), localPort, label: text(input['label'], 160) };
}
export function arity(args: readonly unknown[], count: number): void {
  if (args.length !== count) throw new Error('Unexpected remote operation arguments');
}
