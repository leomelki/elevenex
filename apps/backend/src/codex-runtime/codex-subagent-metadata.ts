import type { CodexSubagentTracker } from './codex-subagents.js';

interface MetadataRead {
  readonly current: () => boolean;
  readonly read: (current: () => boolean) => Promise<void>;
  readonly state: { pending: boolean; loaded: boolean; retryAt: number };
}

/** One metadata-only read per owned child, shared across discovery notifications.
 * No transcript hydration, polling, or timers; failed reads can retry on a later event.
 */
export class CodexSubagentMetadataLoader {
  private readonly states = new WeakMap<
    CodexSubagentTracker,
    Map<string, MetadataRead['state']>
  >();
  private readonly queue: MetadataRead[] = [];
  private active = 0;
  private disposed = false;

  load(
    tracker: CodexSubagentTracker,
    agentId: string,
    current: () => boolean,
    read: MetadataRead['read'],
  ): void {
    if (this.disposed || !current()) return;
    let agents = this.states.get(tracker);
    if (!agents) this.states.set(tracker, (agents = new Map()));
    let state = agents.get(agentId);
    if (!state)
      agents.set(
        agentId,
        (state = { pending: false, loaded: false, retryAt: 0 }),
      );
    if (
      state.pending ||
      state.loaded ||
      state.retryAt > Date.now() ||
      this.queue.length >= 128
    )
      return;
    state.pending = true;
    this.queue.push({ current, read, state });
    this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }

  private drain(): void {
    while (!this.disposed && this.active < 4 && this.queue.length) {
      const job = this.queue.shift()!;
      if (!job.current()) {
        job.state.pending = false;
        continue;
      }
      this.active++;
      void this.run(job);
    }
  }

  private async run(job: MetadataRead): Promise<void> {
    try {
      await job.read(() => !this.disposed && job.current());
      job.state.loaded = true;
    } catch {
      // A child may not yet be readable immediately after its spawn event.
      job.state.retryAt = Date.now() + 1000;
    } finally {
      job.state.pending = false;
      this.active--;
      this.drain();
    }
  }
}
