/** Owns protocol interception resources even after its agent listener is
 * removed. Cleanup aborts paused requests before detaching the session, so
 * cancellation cannot silently turn a mock into a real outgoing request. */
export class ProtocolLease {
  private readonly listeners = new Set<
    (method: string, params: unknown, sessionId?: string) => void
  >();
  private readonly paused = new Map<
    string,
    { requestId: string; sessionId?: string; auth?: boolean }
  >();
  private readonly evaluations = new Map<string, number>();
  private readonly dialogs = new Set<string>();
  private readonly fileChoosers = new Set<string>();
  private closing?: Promise<void>;
  private closed = false;
  constructor(
    private readonly raw: (
      method: string,
      params: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>,
    private readonly detach: () => Promise<void>,
  ) {}
  subscribe(
    listener: (method: string, params: unknown, sessionId?: string) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  receive(method: string, value: unknown, sessionId?: string): void {
    if (!this.closed && method === 'Page.javascriptDialogOpening')
      this.dialogs.add(sessionId ?? '');
    if (method === 'Page.javascriptDialogClosed')
      this.dialogs.delete(sessionId ?? '');
    if (
      (method === 'Fetch.requestPaused' || method === 'Fetch.authRequired') &&
      value &&
      typeof value === 'object'
    ) {
      const requestId = Reflect.get(value, 'requestId');
      if (typeof requestId === 'string') {
        if (this.closed || this.paused.size >= 128)
          void this.raw(
            method === 'Fetch.authRequired'
              ? 'Fetch.continueWithAuth'
              : 'Fetch.failRequest',
            method === 'Fetch.authRequired'
              ? { requestId, authChallengeResponse: { response: 'CancelAuth' } }
              : { requestId, errorReason: 'Aborted' },
            sessionId,
          ).catch(() => undefined);
        else
          this.paused.set((sessionId ?? '') + ':' + requestId, {
            requestId,
            sessionId,
            auth: method === 'Fetch.authRequired',
          });
      }
    }
    if (!this.closed)
      for (const listener of this.listeners) listener(method, value, sessionId);
  }
  async send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed) throw new Error('Protocol lease closed');
    const evaluating =
      method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn';
    const session = sessionId ?? '';
    const pausedKey = session + ':' + String(params['requestId']),
      paused = this.paused.get(pausedKey);
    if (evaluating)
      this.evaluations.set(session, (this.evaluations.get(session) ?? 0) + 1);
    try {
      const result = await this.raw(method, params, sessionId);
      if (method === 'Page.setInterceptFileChooserDialog') {
        if (params['enabled']) this.fileChoosers.add(session);
        else this.fileChoosers.delete(session);
      }
      if (
        [
          'Fetch.fulfillRequest',
          'Fetch.continueRequest',
          'Fetch.failRequest',
          'Fetch.continueResponse',
          'Fetch.continueWithAuth',
        ].includes(method) &&
        this.paused.get(pausedKey) === paused
      )
        this.paused.delete(pausedKey);
      return result;
    } finally {
      if (evaluating) {
        const count = (this.evaluations.get(session) ?? 1) - 1;
        if (count) this.evaluations.set(session, count);
        else this.evaluations.delete(session);
      }
    }
  }
  dispose(): Promise<void> {
    this.closed = true;
    return (this.closing ??= (async () => {
      this.listeners.clear();
      const operations = [...this.paused.values()].map((item) =>
        this.raw(
          item.auth ? 'Fetch.continueWithAuth' : 'Fetch.failRequest',
          item.auth
            ? {
                requestId: item.requestId,
                authChallengeResponse: { response: 'CancelAuth' },
              }
            : { requestId: item.requestId, errorReason: 'Aborted' },
          item.sessionId,
        ).catch(() => undefined),
      );
      this.paused.clear();
      for (const session of this.dialogs)
        operations.push(
          this.raw(
            'Page.handleJavaScriptDialog',
            { accept: false },
            session || undefined,
          ).catch(() => undefined),
        );
      for (const session of this.fileChoosers)
        operations.push(
          this.raw(
            'Page.setInterceptFileChooserDialog',
            { enabled: false },
            session || undefined,
          ).catch(() => undefined),
        );
      this.dialogs.clear();
      this.fileChoosers.clear();
      for (const session of this.evaluations.keys())
        operations.push(
          this.raw(
            'Runtime.terminateExecution',
            {},
            session || undefined,
          ).catch(() => undefined),
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(operations),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 250);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        try {
          await this.detach();
        } catch {
          /* The browser may already have closed the session. */
        }
      }
    })());
  }
}
