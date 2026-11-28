import type { EventEmitter } from 'node:events';
import type { AgentRuntimeProvider } from '../agent-runtime/agent-runtime.types.js';
import type { SessionLaunchDelivery } from '../sessions/session-creation.js';
import type { SessionRuntimeSnapshot } from './tools/session-runtime-state.util.js';
import { untilSessionDeadline } from './tools/session-deadline.js';

type EventSource = Pick<EventEmitter, 'on' | 'off'>;
type Listener<Event> = (event: Event) => void;
type SessionEvent = { sessionId: number };
type RuntimeEvent = {
  type: string;
  payload: SessionEvent & SessionRuntimeSnapshot;
};
type SessionStateRead = {
  controller: AbortController;
  promise: Promise<SessionRuntimeSnapshot | undefined>;
};

/** One source listener per event type, indexed by session even across concurrent MCP calls. */
class SessionEventIndex<Event> {
  private readonly channels = new WeakMap<
    EventSource,
    {
      events: Map<number, Set<Listener<Event>>>;
      dispatch: Listener<Event>;
    }
  >();

  constructor(
    private readonly name: string,
    private readonly sessionId: (event: Event) => number,
  ) {}

  has(source: EventSource, id: number): boolean {
    return this.channels.get(source)?.events.has(id) ?? false;
  }

  subscribe(
    source: EventSource,
    id: number,
    listener: Listener<Event>,
  ): () => void {
    let channel = this.channels.get(source);
    if (!channel) {
      const events = new Map<number, Set<Listener<Event>>>();
      const dispatch = (event: Event) => {
        for (const notify of events.get(this.sessionId(event)) ?? [])
          notify(event);
      };
      channel = { events, dispatch };
      this.channels.set(source, channel);
      source.on(this.name, dispatch);
    }
    const { events, dispatch } = channel;
    const listeners = events.get(id) ?? new Set<Listener<Event>>();
    listeners.add(listener);
    events.set(id, listeners);
    return () => {
      if (!listeners.delete(listener)) return;
      if (!listeners.size) events.delete(id);
      if (!events.size) {
        source.off(this.name, dispatch);
        this.channels.delete(source);
      }
    };
  }
}

export class SessionEventSubscriptions {
  private readonly reads = new WeakMap<
    AgentRuntimeProvider,
    Map<number, SessionStateRead>
  >();
  private readonly runtime = new SessionEventIndex<RuntimeEvent>(
    'event',
    (event) => event.payload.sessionId,
  );
  readonly status = new SessionEventIndex<SessionEvent & { status: string }>(
    'session-status-changed',
    (event) => event.sessionId,
  );
  readonly launch = new SessionEventIndex<
    SessionEvent & { delivery: SessionLaunchDelivery }
  >('session-launch-delivery', (event) => event.sessionId);
  readonly provider = new SessionEventIndex<SessionEvent>(
    'session-provider-changed',
    (event) => event.sessionId,
  );
  readonly handoff = new SessionEventIndex<SessionEvent>('session-handoff-changed', event => event.sessionId);

  watchRuntime(
    runtime: AgentRuntimeProvider,
    id: number,
    listener: Listener<RuntimeEvent>,
  ): () => void {
    const unsubscribe = this.runtime.subscribe(runtime, id, listener);
    return () => {
      unsubscribe();
      if (this.runtime.has(runtime, id)) return;
      const reads = this.reads.get(runtime);
      const pending = reads?.get(id);
      reads?.delete(id);
      pending?.controller.abort();
    };
  }

  readState(
    runtime: AgentRuntimeProvider,
    id: number,
  ): SessionStateRead['promise'] {
    const reads =
      this.reads.get(runtime) ?? new Map<number, SessionStateRead>();
    const pending = reads.get(id);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const operation = Promise.resolve().then(() =>
      controller.signal.aborted
        ? undefined
        : runtime.getRuntimeState(id, { initialize: false }),
    );
    const promise = untilSessionDeadline(operation, 10_000, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (reads.get(id)?.promise === promise) reads.delete(id);
      });
    reads.set(id, { promise, controller });
    this.reads.set(runtime, reads);
    return promise;
  }
}
