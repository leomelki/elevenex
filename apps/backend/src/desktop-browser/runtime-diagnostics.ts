import type { CDPSession } from 'patchright-core';

type Session = Pick<CDPSession, 'on' | 'off' | 'send' | 'detach'>;
type Diagnostic = Readonly<{
  seq: number;
  kind: 'browser' | 'console' | 'pageerror';
  level: string;
  text: string;
  source?: string;
}>;
type ConsoleCapture = {
  readonly ready: Promise<void>;
  stop(): void;
};
type Frame = Readonly<{ id: string; url: string }>;

const historyLimit = 128;
const textLimit = 1024;

/** Diagnostics are retained in memory for the current document and agent lease. */
export class RuntimeBrowserDiagnostics {
  private readonly rows: Diagnostic[] = [];
  private sequence = 0;
  private since = Number.POSITIVE_INFINITY;
  private frame?: Frame;
  private pendingNavigation?: { restoring?: true };
  private capture?: ConsoleCapture;
  private disposed = false;

  constructor(
    private readonly pageSession: Session,
    private readonly attach: () => Promise<Session>,
    private readonly taskServer: (url: URL) => boolean,
    private readonly countError: () => void,
  ) {}

  async start(): Promise<void> {
    this.pageSession.on('Log.entryAdded', this.browserLog);
    await this.pageSession.send('Log.enable').catch(() => undefined);
  }

  control(agent: boolean): void {
    this.since = agent ? Date.now() : Number.POSITIVE_INFINITY;
    this.rows.length = 0;
    this.updateCapture();
  }

  navigationStarted(): void {
    if (this.disposed) return;
    this.pendingNavigation = {};
    this.since = Math.max(this.since, Date.now());
    this.frame = undefined;
    this.rows.length = 0;
    this.updateCapture();
  }

  committed(frame: Frame): void {
    this.pendingNavigation = undefined;
    if (this.frame) this.rows.length = 0;
    this.frame = frame;
    this.updateCapture();
  }

  async navigationStopped(readFrame: () => Promise<Frame>): Promise<void> {
    const navigation = this.pendingNavigation;
    if (!navigation || navigation.restoring) return;
    navigation.restoring = true;
    // A download or cancelled navigation may leave the old document active.
    const frame = await readFrame().catch(() => undefined);
    if (frame && this.pendingNavigation === navigation) this.committed(frame);
  }

  async read(since: number, limit: number) {
    await this.capture?.ready;
    const first = this.rows[0]?.seq ?? this.sequence + 1;
    const matching = this.rows.filter((row) => row.seq > since);
    const items = matching.slice(0, limit);
    return {
      items,
      next: items.at(-1)?.seq ?? this.sequence,
      hasMore: matching.length > limit,
      dropped: since < first - 1,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pendingNavigation = undefined;
    this.rows.length = 0;
    this.updateCapture();
    this.pageSession.off('Log.entryAdded', this.browserLog);
    void this.pageSession.send('Log.disable').catch(() => undefined);
  }

  private readonly browserLog = ({
    entry,
  }: {
    entry: { source: string; level: string; text: string; timestamp: number };
  }) => {
    if (this.disposed) return;
    // Network failures already count through requests and responses.
    if (entry.level === 'error' && entry.source !== 'network')
      this.countError();
    this.record(
      entry.timestamp,
      'browser',
      entry.level,
      entry.text,
      entry.source,
    );
  };

  private record(
    timestamp: number,
    kind: Diagnostic['kind'],
    level: string,
    text: string,
    source?: string,
  ): void {
    if (this.disposed || !Number.isFinite(timestamp) || timestamp <= this.since)
      return;
    this.rows.push({
      seq: ++this.sequence,
      kind,
      level,
      text: text.slice(0, textLimit),
      source,
    });
    if (this.rows.length > historyLimit) this.rows.shift();
  }

  private updateCapture(): void {
    this.capture?.stop();
    this.capture = undefined;
    const frame = this.frame;
    if (
      this.disposed ||
      !frame ||
      !Number.isFinite(this.since) ||
      !URL.canParse(frame.url)
    )
      return;
    const url = new URL(frame.url);
    if (!this.taskServer(url)) return;

    const since = this.since;
    let stopped = false;
    let session: Session | undefined;
    const stop = () => {
      stopped = true;
      if (session) {
        void session.detach().catch(() => undefined);
        session = undefined;
      }
    };
    const ready = this.attach()
      .then(async (cdp) => {
        session = cdp;
        if (stopped) {
          stop();
          return;
        }
        let contextId: number | undefined;
        cdp.on('Runtime.executionContextCreated', ({ context }) => {
          const data: Record<string, unknown> | undefined = context.auxData;
          if (
            data?.['isDefault'] === true &&
            data['frameId'] === frame.id &&
            context.origin === url.origin
          )
            contextId = context.id;
        });
        cdp.on('Runtime.executionContextsCleared', () => {
          contextId = undefined;
        });
        cdp.on(
          'Runtime.executionContextDestroyed',
          ({ executionContextId }) => {
            if (executionContextId === contextId) contextId = undefined;
          },
        );
        // Runtime.enable replays buffered entries. Context and time checks keep
        // earlier human activity and embedded origins out of this agent lease.
        const current = (id: number | undefined, time: number) =>
          !stopped &&
          contextId !== undefined &&
          contextId === id &&
          Number.isFinite(time) &&
          time > since;
        cdp.on('Runtime.consoleAPICalled', (event) => {
          if (!current(event.executionContextId, event.timestamp)) return;
          const text = event.args
            .slice(0, 16)
            .map((arg) =>
              String(
                arg.description ??
                  arg.unserializableValue ??
                  arg.value ??
                  arg.type,
              ).slice(0, textLimit),
            )
            .join(' ');
          this.record(event.timestamp, 'console', event.type, text);
          if (event.type === 'error' || event.type === 'assert')
            this.countError();
        });
        cdp.on(
          'Runtime.exceptionThrown',
          ({ timestamp, exceptionDetails: detail }) => {
            if (!current(detail.executionContextId, timestamp)) return;
            this.record(
              timestamp,
              'pageerror',
              'error',
              detail.exception?.description ?? detail.text,
            );
            this.countError();
          },
        );
        await cdp.send('Runtime.enable');
      })
      .catch(stop);
    this.capture = { ready, stop };
  }
}
