import { constants } from 'node:fs';
import { open, watch } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';

/** The remote daemon publishes availability, never keys or client credentials.
 * Read only at shell-capture boundaries; warm process launches use memory. */
export class SshAgentEnvironment {
  private readonly lifetime = new AbortController();
  private available: boolean | undefined;
  private reading?: Promise<void>;
  private dirty = false;
  private revision = 0;
  private observing = false;
  private readonly statePath: string | undefined;

  constructor(
    private readonly proxy: string | undefined,
    private readonly changed: () => void,
  ) {
    if (proxy === undefined) return;
    if (!isAbsolute(proxy) || proxy.includes('\0') || proxy.length > 1024)
      throw new Error('Invalid managed SSH agent path.');
    this.statePath = proxy + '.state';
  }

  get generation(): number {
    return this.revision;
  }
  get managed(): boolean {
    return this.proxy !== undefined;
  }
  get socket(): string | undefined {
    return this.available ? this.proxy : undefined;
  }

  async prepare(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
    if (this.proxy === undefined) return;
    if (this.lifetime.signal.aborted)
      throw new Error('SSH agent environment is shutting down.');
    const cancellation = AbortSignal.any([signal, this.lifetime.signal]);
    cancellation.throwIfAborted();
    if (!this.observing) {
      this.observing = true;
      void this.observe();
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cancellation.removeEventListener('abort', abort);
        reject(new Error('SSH agent setup cancelled.'));
      };
      cancellation.addEventListener('abort', abort, { once: true });
      void this.refresh().then(
        () => {
          cancellation.removeEventListener('abort', abort);
          resolve();
        },
        (error: unknown) => {
          cancellation.removeEventListener('abort', abort);
          reject(
            error instanceof Error
              ? error
              : new Error('SSH agent state could not be read.', {
                  cause: error,
                }),
          );
        },
      );
    });
    cancellation.throwIfAborted();
    if (this.lifetime.signal.aborted)
      throw new Error('SSH agent environment is shutting down.');
    if (this.socket === undefined) delete env.SSH_AUTH_SOCK;
    else env.SSH_AUTH_SOCK = this.socket;
  }

  dispose(): void {
    this.lifetime.abort();
  }

  private refresh(changedDuringRead = false): Promise<void> {
    if (this.reading) {
      this.dirty ||= changedDuringRead;
      return this.reading;
    }
    this.reading = (async () => {
      do {
        this.dirty = false;
        if (!this.statePath || this.lifetime.signal.aborted) return;
        const file = await open(
          this.statePath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        let available: boolean;
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size !== 1)
            throw new Error('Invalid managed SSH agent state.');
          const data = Buffer.alloc(2);
          const { bytesRead } = await file.read(data, 0, 2, 0);
          if (bytesRead !== 1 || (data[0] !== 48 && data[0] !== 49))
            throw new Error('Invalid managed SSH agent state.');
          available = data[0] === 49;
        } finally {
          await file.close();
        }
        if (this.lifetime.signal.aborted) return;
        if (available !== this.available) {
          const initial = this.available === undefined;
          this.available = available;
          if (!initial) {
            this.revision++;
            this.changed();
          }
        }
      } while (this.dirty);
    })().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async observe(): Promise<void> {
    if (!this.statePath) return;
    try {
      for await (const event of watch(dirname(this.statePath), {
        signal: this.lifetime.signal,
      })) {
        if (
          event.filename !== null &&
          event.filename !== basename(this.statePath)
        )
          continue;
        // Atomic rename is observed on the parent directory. Bursts coalesce
        // into one read plus, at most, one pending read; no directory scans.
        await this.refresh(true).catch(() => undefined);
      }
    } catch {
      // Captures still revalidate the bounded file if watching is unavailable.
      // No stale/invalid state is promoted into a successful shell capture.
    }
  }
}
