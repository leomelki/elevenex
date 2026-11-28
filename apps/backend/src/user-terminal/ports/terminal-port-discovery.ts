import { performance } from 'node:perf_hooks';
import type { TerminalListener } from './port-processes.js';
import {
  scanTerminalPorts,
  type TerminalPortScan,
} from './terminal-port-snapshot.js';

interface Registration {
  readonly pid: number;
  readonly receive: (listeners: readonly TerminalListener[] | null) => void;
  started?: number;
}

/** Manager-owned, demand-driven discovery. Hidden clients create no polling work.
 * One bounded scan serves every terminal/window, with no per-terminal subprocesses. */
export class TerminalPortDiscovery {
  private readonly registrations = new Map<number, Registration>();
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private lastRead = -Infinity;
  private revision = 0;
  private disposed = false;
  private failed = false;

  constructor(
    private readonly scan: TerminalPortScan = scanTerminalPorts,
    private readonly reportFailure: (error: unknown) => void = () => {},
  ) {}

  register(
    id: number,
    pid: number,
    receive: Registration['receive'],
  ): () => void {
    const registration = { pid, receive };
    this.registrations.set(id, registration);
    this.revision++;
    this.lastRead = -Infinity;
    return () => {
      if (this.registrations.get(id) !== registration) return;
      this.registrations.delete(id);
      this.revision++;
      this.lastRead = -Infinity;
      if (!this.registrations.size) this.controller?.abort();
    };
  }

  refresh(fresh = false): Promise<void> {
    if (this.disposed || !this.registrations.size) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!fresh && performance.now() - this.lastRead < 1800)
      return Promise.resolve();
    const registrations = new Map(this.registrations);
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 3500);
    const pending = Promise.resolve()
      .then(async () => {
        let snapshot: Awaited<ReturnType<TerminalPortScan>> | null = null;
        try {
          snapshot = await this.scan(
            [...new Set([...registrations.values()].map((entry) => entry.pid))],
            controller.signal,
          );
        } catch (error) {
          // Permissions, missing tools, resource bounds and timeout are unknown,
          // never evidence that a printed URL is a listening service.
          if (!this.failed && !controller.signal.aborted && !this.disposed)
            this.reportFailure(error);
          this.failed = true;
        }
        if (snapshot) this.failed = false;
        if (this.disposed) return;
        for (const [id, registration] of registrations) {
          if (this.registrations.get(id) !== registration) continue;
          const started = snapshot?.roots.get(registration.pid);
          if (
            started === undefined ||
            (registration.started !== undefined &&
              registration.started !== started)
          ) {
            registration.receive(null);
            continue;
          }
          registration.started = started;
          registration.receive(
            snapshot?.listeners.get(registration.pid) ?? null,
          );
        }
        if (this.revision === revision) this.lastRead = performance.now();
      })
      .finally(() => {
        clearTimeout(deadline);
        if (this.pending === pending) this.pending = null;
        if (this.controller === controller) this.controller = null;
      });
    this.pending = pending;
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.registrations.clear();
    this.controller?.abort();
  }
}
