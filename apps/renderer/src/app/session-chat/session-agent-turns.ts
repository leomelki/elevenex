import type {
  DelegatedSessionWork, SessionAgentReference, SessionAgentTurnEntry, SessionChatBackgroundWork,
  SessionChatState, SessionChatWorkEvent,
} from '@elevenex/shared';
import {
  agentWorkLive, sessionAgentTitle,
  type AgentWorkAction, type AgentWorkCard, type AgentWorkMessage, type AgentWorkTarget,
  type ChatExchange, type WorkStep,
} from '../conversation';
import { formatUsage } from './session-activity-model';

const CARD_LIMIT = 16;
const MESSAGE_LIMIT = 6;
const timestamp = (value?: string | null) => {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
};
type Runtime = {
  readonly sessions: ReadonlyMap<number, DelegatedSessionWork>;
  readonly native: ReadonlyMap<string, SessionChatBackgroundWork>;
  readonly recent: ReadonlyMap<string, SessionChatWorkEvent>;
  readonly references: ReadonlyMap<number, SessionAgentReference>;
};
type AgentState = Pick<SessionChatState, 'work' | 'provider' | 'delegation' | 'nativeAgentInspection'>;
type Launch = { readonly key: string; readonly entry: SessionAgentTurnEntry };

function indexRuntime(state: AgentState | null, exchanges: readonly ChatExchange[]): Runtime {
  const native = new Map<string, SessionChatBackgroundWork>(), recent = new Map<string, SessionChatWorkEvent>();
  for (const item of state?.work?.running ?? []) {
    if (item.agentId) native.set(item.agentId, item);
    if (item.parentToolUseId) native.set(item.parentToolUseId, item);
  }
  for (const item of state?.work?.recent ?? []) {
    if (item.agentId) recent.set(item.agentId, item);
    if (item.parentToolUseId) recent.set(item.parentToolUseId, item);
  }
  const references = new Map<number, SessionAgentReference>();
  for (const exchange of exchanges) {
    const add = (entry: SessionAgentTurnEntry | undefined) => {
      const reference = entry?.result?.session;
      if (reference?.title) references.set(reference.sessionId, reference);
    };
    for (const entry of exchange.agentIndex ?? []) add(entry);
    for (const step of exchange.steps) add(step.agentEntry);
  }
  return { native, recent, references, sessions: new Map(state?.work?.sessions?.map(item => [item.session.sessionId, item])) };
}

function target(session?: SessionAgentReference): AgentWorkTarget | undefined {
  return session && { kind: 'session', session };
}
function sessionOf(entry: SessionAgentTurnEntry, runtime: Runtime): SessionAgentReference | undefined {
  const receipt = entry.result?.session;
  const id = receipt?.sessionId ?? (entry.operation.sessions?.length === 1 ? entry.operation.sessions[0] : undefined);
  if (!id) return undefined;
  const known = runtime.sessions.get(id)?.session ?? runtime.references.get(id);
  return known ? {
    sessionId: id, taskId: known.taskId ?? receipt?.taskId, title: known.title ?? receipt?.title,
    selection: known.selection ?? receipt?.selection,
  } : receipt ?? { sessionId: id };
}
function sessionLabel(entry: SessionAgentTurnEntry, runtime: Runtime): string {
  const ref = sessionOf(entry, runtime);
  return ref?.title || entry.operation.title || (ref ? sessionAgentTitle(ref) : 'agent');
}
function waitingFor(entry: SessionAgentTurnEntry, runtime: Runtime): string {
  const ids = entry.operation.sessions ?? [];
  if (ids.length === 1) return sessionLabel(entry, runtime);
  const titles = ids.map(id => (runtime.sessions.get(id)?.session ?? runtime.references.get(id))?.title);
  if (ids.length > 1 && ids.length <= 2 && titles.every(Boolean)) return titles.join(' and ');
  return ids.length ? ids.length + ' agents' : 'agents';
}
function messageStatus(entry: SessionAgentTurnEntry, work?: DelegatedSessionWork): AgentWorkMessage['status'] {
  const receipt = entry.result;
  if (entry.failed) return 'Failed';
  if (receipt?.messageId && work?.delivered?.includes(receipt.messageId)) return 'Delivered';
  if (receipt?.delivery === 'queued') return 'Queued';
  if (receipt?.delivery === 'accepted') return 'Delivered';
  if (entry.endedAt || receipt) return 'Unconfirmed';
  return 'Sending…';
}

function describe(entry: SessionAgentTurnEntry, runtime: Runtime, live: boolean): AgentWorkAction {
  const { operation, result, failed } = entry;
  const active = live && !entry.endedAt && !failed;
  const name = sessionLabel(entry, runtime);
  const session = sessionOf(entry, runtime);
  const detail = result?.detail;
  switch (operation.type) {
    case 'message':
      return {
        label: (failed ? 'Couldn’t message ' : active ? 'Messaging ' : 'Messaged ') + name,
        detail: detail ?? operation.message,
        status: active || entry.endedAt ? messageStatus(entry, session && runtime.sessions.get(session.sessionId)) : 'Unconfirmed',
        target: target(session),
      };
    case 'wait': {
      const before = waitingFor(entry, runtime);
      const label = failed ? 'Couldn’t wait for ' + before
        : active ? 'Waiting for ' + before
        : result?.event === 'timeout' ? 'Stopped waiting for ' + before
        : result?.status === 'waiting' ? name + ' needs you'
        : result?.status === 'error' ? name + ' failed'
        : result?.status === 'paused' ? name + ' paused'
        : result?.status === 'completed' ? name + ' finished'
        : 'Wait ended for ' + before;
      return { label, detail: failed ? detail : undefined, target: target(session) };
    }
    case 'stop':
      return { label: (failed ? 'Couldn’t stop ' : active ? 'Stopping ' : 'Stopped ') + name, detail, target: target(session) };
    case 'read':
    case 'search':
      return {
        label: (operation.type === 'read' ? (failed ? 'Couldn’t read ' : active ? 'Reading ' : 'Read ')
          : (failed ? 'Couldn’t search ' : active ? 'Searching ' : 'Searched ')) + name,
        detail, target: target(session),
      };
    case 'catalog':
      return { label: failed ? 'Couldn’t check available agents' : active ? 'Checking available agents' : 'Checked available agents', detail };
    case 'native-wait': {
      const count = operation.agents?.length ?? 0;
      const names = operation.agents?.map(id => runtime.native.get(id)?.title).filter(Boolean);
      const group = names?.length === count && names.length ? names.join(' and ') :
        count ? count + (count === 1 ? ' agent' : ' agents') : 'agents';
      return { label: (active ? 'Waiting for ' : failed ? 'Couldn’t wait for ' : 'Wait ended for ') + group };
    }
    case 'launch':
    case 'native':
      return { label: (failed ? 'Couldn’t start ' : active ? 'Starting ' : 'Started ') + name, detail, target: target(session) };
  }
}

function cardFor(launch: Launch, operations: readonly SessionAgentTurnEntry[], runtime: Runtime, state: AgentState | null, live: boolean): AgentWorkCard {
  const { key, entry } = launch;
  const { result, operation } = entry;
  const startedAt = timestamp(entry.at);
  const endedAt = timestamp(entry.endedAt);
  const failed = entry.failed || result?.status === 'error';
  if (operation.type === 'native') {
    const lookup = result?.agentId ?? entry.toolId ?? entry.id;
    const work = runtime.native.get(lookup), recent = runtime.recent.get(lookup);
    const agentId = work?.agentId ?? recent?.agentId ?? result?.agentId;
    const received = agentId ? operations.flatMap(operation => operation.result?.agents?.flatMap(agent =>
      agent.agentId === agentId ? [{ ...agent, endedAt: operation.endedAt }] : []) ?? []).at(-1) : undefined;
    const receipt = result?.status;
    const reported = receipt === 'running' && !live ? 'unavailable' : receipt;
    const status = work?.status ?? recent?.agentStatus ?? received?.status ?? (failed ? 'error' : reported ?? (live ? 'pending' : 'unavailable'));
    return {
      id: key, title: work?.title || operation.title || work?.label || 'Agent',
      status, selection: state?.provider ? { provider: state.provider, model: work?.model } : undefined,
      role: work?.role ?? operation.message,
      detail: work?.detail || recent?.detail || received?.detail || result?.detail || '',
      startedAt: timestamp(work?.startedAt) ?? startedAt,
      endedAt: agentWorkLive(status) ? undefined : timestamp(recent?.at ?? received?.endedAt) ?? endedAt,
      usage: work ? formatUsage(work) : '', stoppable: work?.stoppable,
      target: agentId && (state?.nativeAgentInspection || work?.inspectable || recent)
        ? { kind: 'native', agentId } : undefined,
    };
  }
  const ref = sessionOf(entry, runtime);
  const progress = ref && runtime.sessions.get(ref.sessionId);
  const related = ref ? operations.filter(op => op !== entry && (
    op.result?.session?.sessionId === ref.sessionId ||
    (!op.result?.session && op.operation.sessions?.length === 1 && op.operation.sessions[0] === ref.sessionId)
  )) : [];
  const terminal = related.filter(op => !op.failed && (
    (op.operation.type === 'wait' && (op.result?.status === 'completed' || op.result?.status === 'error')) ||
    (op.operation.type === 'stop' && op.result?.status === 'stopped')
  )).at(-1);
  const lastTouch = timestamp(terminal?.endedAt);
  const latestMessage = related.filter(op => op.operation.type === 'message' && !op.failed).at(-1);
  const superseded = latestMessage && (timestamp(latestMessage.at) ?? 0) > (lastTouch ?? Infinity);
  const recorded = !superseded ? terminal : undefined;
  // A later turn in the same session must not rewrite a recorded handoff.
  const status = recorded?.result?.status ?? progress?.status ??
    (failed ? 'error' : result?.status === 'running' && !live ? 'unavailable' : result?.status) ??
    (live ? 'pending' : 'unavailable');
  const messages = related.filter(op => op.operation.type === 'message' && op.operation.message).slice(-MESSAGE_LIMIT)
    .map(op => ({ id: op.id, text: op.operation.message!, status: !live && !op.endedAt ? 'Unconfirmed' as const : messageStatus(op, progress) }));
  return {
    id: key, title: ref?.title || operation.title || (ref ? sessionAgentTitle(ref) : 'Agent session'),
    status, selection: ref?.selection ?? operation.identity, ownSession: true,
    detail: recorded?.result?.detail || (failed && !progress ? result?.detail : undefined) || progress?.detail || result?.detail || '',
    startedAt: recorded ? startedAt : timestamp(progress?.startedAt) ?? startedAt,
    endedAt: agentWorkLive(status) ? undefined : timestamp(recorded?.endedAt ?? progress?.endedAt) ?? endedAt,
    usage: progress ? formatUsage(progress) : '', target: target(ref),
    stoppable: !recorded && (progress?.status === 'running' || progress?.status === 'waiting'),
    ...(messages.length ? { messages } : {}),
  };
}

function launches(operations: readonly SessionAgentTurnEntry[]): readonly Launch[] {
  const found = new Map<string, Launch>();
  for (const entry of operations) {
    const { operation, result } = entry;
    if (operation.type !== 'launch' && operation.type !== 'native') continue;
    const identity = operation.requestId ? 'request:' + operation.requestId :
      result?.session ? 'session:' + result.session.sessionId : entry.id;
    const previous = found.get(identity);
    if (!previous && found.size >= CARD_LIMIT) break;
    // Keep the first mounted row through a retry. An unconfirmed replay cannot
    // replace an earlier receipt with fewer facts.
    if (previous?.entry.result?.session && !result?.session) continue;
    found.set(identity, { key: previous?.key ?? entry.id, entry });
  }
  return [...found.values()];
}

function project(exchange: ChatExchange, runtime: Runtime, state: AgentState | null, taskId?: number) {
  const returns = state?.delegation?.returns;
  const returnedTo = returns?.filter(receipt => exchange.replyIds?.includes(receipt.itemId));
  const sender = exchange.sender;
  const parent = state?.delegation?.parent;
  const upgradedSender = sender && !sender.session.title && parent?.sessionId === sender.session.sessionId
    ? { ...sender, session: parent } : sender;
  if (!exchange.agentIndex?.length && !exchange.steps.some(step => step.agentEntry)) {
    return returnedTo?.length || upgradedSender !== sender ? { ...exchange, sender: upgradedSender, returnedTo } : exchange;
  }
  const calls = new Map(exchange.agentIndex?.map(entry => [entry.id, entry]));
  for (const step of exchange.steps) {
    const entry = step.agentEntry;
    if (!entry) continue;
    const prior = calls.get(entry.id);
    // A full reply on the receipt cannot replace a compact call's preview.
    if (!prior?.result || (step.id === entry.id && entry.result)) calls.set(entry.id, entry);
    if (entry.result?.reply && !calls.get(entry.id)?.result?.detail)
      calls.set(entry.id, { ...entry, result: { ...entry.result, detail: entry.result.reply.text.replace(/\s+/g, ' ').slice(0, 360), reply: undefined } });
  }
  const operations = [...calls.values()];
  const live = exchange.status === 'live';
  const groups = launches(operations);
  const cards = groups.map(launch => cardFor(launch, operations, runtime, state, live));
  const ownSessions = new Set(cards.flatMap(card => card.target?.kind === 'session' ? [card.target.session.sessionId] : []));
  const native = new Set(cards.flatMap(card => card.target?.kind === 'native' ? [card.target.agentId] : []));
  const first = groups[0]?.key;
  const waiting = operations.filter(entry => (entry.operation.type === 'wait' || entry.operation.type === 'native-wait') && !entry.failed).at(-1);
  const coversNative = (entry: SessionAgentTurnEntry) => !!entry.operation.agents?.length && entry.operation.agents.every(id => native.has(id));
  const attachedWait = waiting && ((!!waiting.operation.sessions?.length && waiting.operation.sessions.every(id => ownSessions.has(id))) || coversNative(waiting));
  const wait = attachedWait && live
    ? waiting.result?.status === 'completed' && waiting.result.session
      ? sessionLabel(waiting, runtime) + ' replied'
      : describe(waiting, runtime, live).label
    : undefined;
  const steps = exchange.steps.flatMap((step): WorkStep[] => {
    const source = step.agentEntry;
    if (!source) return [step];
    const reply = step.id !== source.id ? source.result?.reply : undefined;
    if (reply && source.result?.session) {
      const ref = sessionOf(source, runtime) ?? source.result.session;
      const changes = ref.taskId === taskId ? reply.changes : undefined;
      return [{ ...step, kind: 'note', agentReply: {
        session: ref, replyId: reply.id, text: reply.text, truncated: reply.truncated,
        files: changes?.files, totalFiles: changes?.total, sharedChanges: changes?.shared,
      } }];
    }
    const entry = calls.get(source.id) ?? source;
    if (step.id === first && cards.length)
      return [{ ...step, agentBoard: { agents: cards, wait, waiting: !!wait && !waiting?.endedAt }, status: live ? 'running' : 'done' }];
    if (groups.some(launch => launch.entry.id === entry.id || launch.key === step.id)) return [];
    if (entry.operation.requestId && operations.some(other => other !== entry &&
        other.operation.requestId === entry.operation.requestId && groups.some(launch => launch.entry.id === other.id))) return [];
    const ref = sessionOf(entry, runtime);
    const mergedMessage = entry.operation.type === 'message' && ref && ownSessions.has(ref.sessionId);
    const mergedWait = entry.operation.type === 'wait' && !entry.failed &&
      !!entry.operation.sessions?.length && entry.operation.sessions.every(id => ownSessions.has(id)) &&
      (entry === waiting || entry.result?.status === 'completed');
    if (mergedMessage || mergedWait || (entry.operation.type === 'native-wait' && !entry.failed && coversNative(entry))) return [];
    return [{ ...step, agentAction: describe(entry, runtime, live) }];
  });
  const boundary = exchange.answerBeforeStepId
    ? exchange.steps.slice(exchange.steps.findIndex(step => step.id === exchange.answerBeforeStepId))
    : [];
  const retained = new Set(steps.map(step => step.id));
  return { ...exchange, steps, agentCards: cards, sender: upgradedSender, returnedTo,
    answerBeforeStepId: boundary.find(step => retained.has(step.id))?.id };
}

/** Keeps unaffected turns referentially stable through child-only feed updates. */
export class SessionAgentTurnProjection {
  private readonly cache = new WeakMap<ChatExchange, { signature: string; exchange: ChatExchange }>();

  project(exchanges: readonly ChatExchange[], state: AgentState | null, taskId?: number): readonly ChatExchange[] {
    const runtime = indexRuntime(state, exchanges);
    return exchanges.map(exchange => {
      const next = project(exchange, runtime, state, taskId);
      if (next === exchange) return exchange;
      const signature = JSON.stringify([next.agentCards, next.sender, next.returnedTo,
        next.steps.flatMap(step => step.agentAction || step.agentBoard || step.agentReply
          ? [[step.id, step.agentAction, step.agentBoard?.wait, step.agentReply?.session]] : [])]);
      const old = this.cache.get(exchange);
      if (old?.signature === signature) return old.exchange;
      this.cache.set(exchange, { signature, exchange: next });
      return next;
    });
  }
}
