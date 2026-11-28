import { object } from './host.js';

/** Public Playwright CDPSession exposes one session. Non-flattened child
 * messages let us forward OOPIF/worker sessions without private client APIs. */
export class NestedSessions {
  private nextId = 0;
  private readonly parents = new Map<string, string | undefined>();
  private readonly pending = new Map<
    number,
    {
      sessionId: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  constructor(
    private readonly rootSend: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}
  async send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed || (sessionId && !this.parents.has(sessionId)))
      throw new Error('Child protocol session is outside this page lease');
    const input =
      method === 'Target.setAutoAttach'
        ? { ...params, flatten: false }
        : params;
    if (!sessionId) return this.rootSend(method, input);
    if (this.pending.size >= 512)
      throw new Error('Child protocol request limit reached');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Child protocol request timed out'));
      }, 15000);
      this.pending.set(id, { sessionId, resolve, reject, timer });
      void this.send(
        'Target.sendMessageToTarget',
        { sessionId, message: JSON.stringify({ id, method, params: input }) },
        this.parents.get(sessionId),
      ).catch((error) => {
        const item = this.pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  receive(
    method: string,
    params: unknown,
    emit: (method: string, params: unknown, sessionId?: string) => void,
    sessionId?: string,
  ): void {
    if (this.closed) return;
    if (method !== 'Target.receivedMessageFromTarget') {
      if (method === 'Target.attachedToTarget') {
        const item = object(params);
        if (typeof item['sessionId'] === 'string') {
          if (this.parents.size >= 128) {
            void this.send(
              'Target.detachFromTarget',
              { sessionId: item['sessionId'] },
              sessionId,
            ).catch(() => undefined);
            return;
          }
          this.parents.set(item['sessionId'], sessionId);
        }
      }
      if (method === 'Target.detachedFromTarget') {
        const id = object(params)['sessionId'];
        if (typeof id === 'string') this.detached(id);
      }
      emit(method, params, sessionId);
      return;
    }
    const envelope = object(params);
    if (
      typeof envelope['message'] !== 'string' ||
      typeof envelope['sessionId'] !== 'string'
    )
      return;
    const message = object(JSON.parse(envelope['message']) as unknown);
    if (typeof message['id'] === 'number') {
      const item = this.pending.get(message['id']);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(message['id']);
      if (message['error'])
        item.reject(
          new Error(
            String(
              object(message['error'])['message'] ?? 'Protocol command failed',
            ),
          ),
        );
      else item.resolve(message['result'] ?? {});
    } else if (typeof message['method'] === 'string')
      this.receive(
        message['method'],
        message['params'],
        emit,
        envelope['sessionId'],
      );
  }
  dispose(): void {
    this.closed = true;
    this.parents.clear();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Protocol session closed'));
    }
    this.pending.clear();
  }
  private detached(id: string): void {
    this.parents.delete(id);
    for (const [child, parent] of this.parents)
      if (parent === id) this.detached(child);
    for (const [key, item] of this.pending)
      if (item.sessionId === id) {
        clearTimeout(item.timer);
        this.pending.delete(key);
        item.reject(new Error('Child protocol target detached'));
      }
  }
}
