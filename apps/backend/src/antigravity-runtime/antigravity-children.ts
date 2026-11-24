import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import type { ClaudeSubagentState } from '../claude-runtime/claude-runtime.types.js';
import { acpObject } from './acp-stdio.js';
import { acpList, acpText } from './antigravity-acp.js';

const NATIVE_ID = /^[\w-]{1,80}$/;
const CHILD_LIMIT = 32;
const METADATA_LIMIT = 64 * 1024;
const TRANSCRIPT_LIMIT = 192 * 1024;
const NEW_CHILD_GRACE = 6_000;
const SYSTEM = '.system_generated';

interface Launch {
  role: string;
  prompt: string;
}

export interface AntigravityBatch {
  nativeToolId: string;
  agent: ClaudeSubagentState;
  launches: Launch[];
}

interface NativeChild {
  id: string;
  toolId: string;
  launch: Launch;
  killed: boolean;
  reported: boolean;
}

export function antigravityBrain(env: NodeJS.ProcessEnv) {
  const home =
    (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  return join(home, '.gemini', 'antigravity-cli', 'brain');
}

export function antigravityLaunches(data: unknown): Launch[] {
  const input = acpObject(data);
  return (
    Array.isArray(input.Subagents)
      ? acpList(input.Subagents, CHILD_LIMIT)
      : [input]
  )
    .map(acpObject)
    .flatMap(({ Role, Prompt }) => {
      const role = acpText(Role, 160);
      const prompt = acpText(Prompt, 4000);
      return role || prompt ? [{ role, prompt }] : [];
    });
}

export function antigravityBatch(
  rowId: number,
  item: AgentTranscriptItem,
): AntigravityBatch | undefined {
  if (item.kind !== 'tool_use' || item.toolKind !== 'task_agent') return;
  const nativeToolId = item.id.split(':tool:')[1];
  if (!nativeToolId) return;
  const id = `agy-${rowId}-${createHash('sha256').update(item.id).digest('hex').slice(0, 24)}`;
  const launches = antigravityLaunches(item.toolInput);
  const title = launches
    .map(({ role }) => role)
    .filter(Boolean)
    .join(', ')
    .slice(0, 120);
  return {
    nativeToolId,
    launches,
    agent: {
      agentId: id,
      agentType: 'Antigravity subagents',
      displayName: title || 'Antigravity subagents',
      parentToolUseId: item.id,
      prompt: launches
        .map(({ role, prompt }) => (role ? `${role}\n${prompt}` : prompt))
        .join('\n\n')
        .slice(0, 4000),
      timestamp: item.timestamp,
      startedAt: item.timestamp,
      status: 'started',
      executionStatus: 'running',
      isBackgrounded: true,
    },
  };
}

async function confined(root: string, segments: string[]) {
  const target = join(root, ...segments);
  // Paths come from fixed profile locations and validated native IDs. Reject
  // redirected records, including redirects within the profile.
  return (await realpath(target).catch(() => undefined)) === target
    ? target
    : undefined;
}

async function withFile<T>(
  root: string,
  segments: string[],
  read: (file: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>,
) {
  const path = await confined(root, segments);
  if (!path) return;
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) return;
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.nlink !== 1
    )
      return;
    return await read(file, current.size);
  } finally {
    await file.close();
  }
}

async function boundedNames(root: string, segments: string[], limit: number) {
  const path = await confined(root, segments);
  if (!path) return [];
  const names: string[] = [];
  let entries = 0;
  for await (const entry of await opendir(path)) {
    if (++entries > limit) return [];
    if (
      entry.isFile() &&
      entry.name.endsWith('.json') &&
      entry.name !== 'read.json'
    )
      names.push(entry.name);
  }
  return names;
}

async function readJson(root: string, segments: string[]) {
  return withFile(root, segments, async (file, size) => {
    if (size > METADATA_LIMIT) return;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, 0);
    return acpObject(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
  }).catch(() => undefined);
}

async function inbox(root: string, id: string) {
  const path = [id, SYSTEM, 'messages'];
  const messages = [];
  for (const name of await boundedNames(root, path, 96)) {
    const message = await readJson(root, [...path, name]);
    if (message) messages.push(message);
  }
  return messages;
}

/** agy 1.5 records each child under its parent and records the launch in the child's inbox. */
export async function readAntigravityChildren(
  root: string,
  parent: string,
): Promise<NativeChild[]> {
  if (!NATIVE_ID.test(parent)) return [];
  try {
    const path = [parent, SYSTEM, 'subagents'];
    const names = await boundedNames(root, path, CHILD_LIMIT);
    if (!names.length) return [];
    const senders = new Set(
      (await inbox(root, parent)).map(({ sender }) => sender),
    );
    const children: NativeChild[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!NATIVE_ID.test(id) || id === parent) continue;
      const descriptor = await readJson(root, [...path, name]);
      if (
        !descriptor ||
        (descriptor.conversationId !== undefined &&
          descriptor.conversationId !== id)
      )
        continue;
      for (const message of await inbox(root, id)) {
        const tool = acpObject(acpObject(message.sourceMetadata).tool);
        const call = acpObject(tool.toolCall);
        if (
          message.sender !== parent ||
          (tool.conversationId !== undefined &&
            tool.conversationId !== parent) ||
          call.name !== 'invoke_subagent' ||
          typeof call.id !== 'string'
        )
          continue;
        let launch: Launch | undefined;
        if (typeof call.argumentsJson === 'string') {
          try {
            [launch] = antigravityLaunches(JSON.parse(call.argumentsJson));
          } catch {
            /* Old records omit arguments. */
          }
        }
        children.push({
          id,
          toolId: call.id,
          launch: launch ?? {
            role: acpText(acpObject(descriptor.subagentDescriptor).role, 160),
            prompt: acpText(message.content, 4000),
          },
          killed: descriptor.state === 'SUBAGENT_STATE_KILLED',
          reported: senders.has(id),
        });
        break;
      }
    }
    return children;
  } catch {
    return [];
  }
}

function matchingChildren(
  batch: AntigravityBatch,
  children: NativeChild[],
  siblings: AntigravityBatch[],
) {
  const exact = children.filter(({ toolId }) => toolId === batch.nativeToolId);
  if (exact.length) return exact;
  // Permission and auto-approved launch IDs can differ. Accept a text match
  // only when one parent launch and one native child can claim that text.
  return batch.launches.flatMap((launch) => {
    const matches = (other: Launch) =>
      !!launch.role &&
      !!launch.prompt &&
      launch.role === other.role &&
      launch.prompt === other.prompt;
    const candidates = children.filter(
      (child) =>
        matches(child.launch) &&
        !siblings.some(({ nativeToolId }) => nativeToolId === child.toolId),
    );
    return candidates.length === 1 &&
      siblings.flatMap(({ launches }) => launches).filter(matches).length === 1
      ? candidates
      : [];
  });
}

export function antigravityBatchState(
  batch: AntigravityBatch,
  children: NativeChild[],
  siblings: AntigravityBatch[],
  pending: boolean,
): ClaudeSubagentState {
  const owned = matchingChildren(batch, children, siblings);
  const live =
    pending &&
    (owned.some((child) => !child.killed && !child.reported) ||
      (!owned.length &&
        Date.now() - Date.parse(batch.agent.timestamp) < NEW_CHILD_GRACE));
  return live
    ? batch.agent
    : {
        ...batch.agent,
        status: 'stopped',
        // A child's inbox reply can ask the parent for guidance. It does not prove success.
        executionStatus: 'unavailable',
      };
}

export async function readAntigravityBatchHistory(
  root: string,
  batch: AntigravityBatch,
  children: NativeChild[],
  siblings: AntigravityBatch[],
): Promise<AgentTranscriptItem[]> {
  const history: AgentTranscriptItem[] = [];
  for (const child of matchingChildren(batch, children, siblings).slice(
    0,
    12,
  )) {
    const id = `${batch.agent.agentId}-${child.id}`;
    history.push({
      id,
      kind: 'user',
      content: [child.launch.role, child.launch.prompt]
        .filter(Boolean)
        .join('\n\n'),
      editUnsupported: true,
      timestamp: batch.agent.timestamp,
    });
    const tail = await withFile(
      root,
      [child.id, SYSTEM, 'logs', 'transcript.jsonl'],
      async (file, size) => {
        const start = Math.max(0, size - TRANSCRIPT_LIMIT);
        const buffer = Buffer.alloc(size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
        if (start) lines.shift();
        return lines.slice(-32);
      },
    ).catch(() => undefined);
    for (const line of tail ?? []) {
      try {
        const step = acpObject(JSON.parse(line));
        if (
          !Number.isSafeInteger(step.step_index) ||
          (step.step_index === 0 && step.type === 'SYSTEM_MESSAGE')
        )
          continue;
        const content =
          acpText(step.content ?? step.error, 4000) ||
          acpList(step.tool_calls, 16)
            .map((call) => acpText(acpObject(call).name, 120))
            .filter(Boolean)
            .join(', ');
        if (!content) continue;
        history.push({
          id: `${id}-${step.step_index}`,
          content,
          kind: step.type === 'PLANNER_RESPONSE' ? 'assistant' : 'system',
          timestamp: batch.agent.timestamp,
        });
      } catch {
        // A live transcript can end in a partial line; the next read can include it.
      }
    }
  }
  return history;
}

/** One live batch window per conversation. Only active launches need a profile poll. */
export class AntigravitySubagents {
  private readonly batches: Map<string, AntigravityBatch>;
  private root?: string;
  private parent?: string;
  private poll?: NodeJS.Timeout;
  private generation = 0;

  constructor(
    saved: AntigravityBatch[],
    private readonly changed: (work: AntigravityBatch[]) => void,
  ) {
    this.batches = new Map(saved.map((batch) => [batch.agent.agentId, batch]));
  }

  get records() {
    return [...this.batches.values()];
  }

  connect(root: string, parent: string | null) {
    this.root = root;
    this.parent = parent ?? undefined;
  }

  record(batch: AntigravityBatch, failed: boolean) {
    const { agentId } = batch.agent;
    const previous = this.batches.get(agentId);
    if (previous && !batch.launches.length) {
      batch.launches = previous.launches;
      batch.agent = previous.agent;
    }
    if (failed) {
      batch.agent = {
        ...batch.agent,
        status: 'stopped',
        executionStatus: 'error',
      };
    } else if (previous?.agent.status === 'stopped') {
      batch.agent = previous.agent;
    }
    this.batches.set(agentId, batch);
    if (this.batches.size > 48) {
      const oldest = [...this.batches].find(
        ([, value]) => value.agent.status === 'stopped',
      );
      this.batches.delete(oldest?.[0] ?? agentId);
    }
    this.publish();
    this.schedule();
  }

  private publish() {
    this.changed(
      this.records.filter(({ agent }) => agent.status === 'started'),
    );
  }

  private schedule() {
    if (
      this.poll ||
      !this.records.some(({ agent }) => agent.status === 'started')
    )
      return;
    const { root, parent, generation } = this;
    if (!root || !parent) return;
    this.poll = setTimeout(async () => {
      const children = await readAntigravityChildren(root, parent);
      if (this.generation !== generation) return;
      this.poll = undefined;
      const batches = this.records;
      let changed = false;
      for (const batch of batches) {
        if (batch.agent.status !== 'started') continue;
        const state = antigravityBatchState(batch, children, batches, true);
        if (state !== batch.agent) {
          batch.agent = state;
          changed = true;
        }
      }
      if (changed) this.publish();
      this.schedule();
    }, 2_000).unref();
  }

  stop() {
    clearTimeout(this.poll);
    this.poll = undefined;
    this.generation++;
    for (const batch of this.batches.values()) {
      if (batch.agent.status === 'started')
        batch.agent = antigravityBatchState(batch, [], [], false);
    }
  }
}
