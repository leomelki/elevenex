import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

export function toolKey(item: AgentTranscriptItem): string {
  return item.toolUseId ?? item.id;
}

const roles = ['call', 'result'] as const;
type Role = (typeof roles)[number];
type Pair<T> = Partial<Record<Role, T>>;

function roleOf(item: AgentTranscriptItem): Role | undefined {
  if (item.kind === 'tool_use') return 'call';
  if (item.kind === 'tool_result' && item.toolUseId) return 'result';
}

/** Resolve only operations represented by this page. Saved lookups can reuse
 * source offsets across pages without retaining tool input/output or history. */
export class ChatToolLinks {
  private readonly pairs = new Map<string, Pair<AgentTranscriptItem>>();

  constructor(items: Iterable<AgentTranscriptItem>) {
    for (const item of items) {
      const role = roleOf(item);
      if (!role) continue;
      const key = toolKey(item);
      const pair = this.pairs.get(key) ?? {};
      pair[role] = item;
      this.pairs.set(key, pair);
    }
  }

  peer(item: AgentTranscriptItem): AgentTranscriptItem | undefined {
    const role = roleOf(item);
    if (!role) return;
    const peer = this.pairs.get(toolKey(item))?.[role === 'call' ? 'result' : 'call'];
    return peer?.id !== item.id ? peer : undefined;
  }

  isLatest(item: AgentTranscriptItem): boolean {
    const role = roleOf(item);
    return role ? this.pairs.get(toolKey(item))?.[role] === item : item.kind === 'tool_result';
  }

  findMissing(source: readonly AgentTranscriptItem[], positions?: Map<string, Pair<number>>): void {
    if (!source.length) return;
    const missing = { call: new Set<string>(), result: new Set<string>() };
    for (const [key, pair] of this.pairs) {
      const saved = positions?.get(key);
      for (const role of roles) {
        if (pair[role]) continue;
        const at = saved?.[role];
        if (at === -1) continue;
        const item = at === undefined ? undefined : source[at];
        if (item && roleOf(item) === role && toolKey(item) === key) pair[role] = item;
        else missing[role].add(key);
      }
    }
    const remember = (key: string, role: Role, at: number): void => {
      if (!positions) return;
      const pair = positions.get(key) ?? {};
      pair[role] = at;
      positions.delete(key);
      positions.set(key, pair);
      if (positions.size > 1024) positions.delete(positions.keys().next().value!);
    };
    for (let at = source.length - 1; at >= 0 && (missing.call.size || missing.result.size); at--) {
      const item = source[at];
      const role = roleOf(item);
      if (!role) continue;
      const key = toolKey(item);
      if (!missing[role].delete(key)) continue;
      this.pairs.get(key)![role] = item;
      remember(key, role, at);
    }
    for (const role of roles)
      for (const key of missing[role]) remember(key, role, -1);
  }
}

export type ChatToolPositions = Map<string, Pair<number>>;
