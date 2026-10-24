import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { EditorWorkQueue, waitForEditorWork } from '../files/editor-work.js';
import { buildAugmentedEnv } from '../config/system-paths.js';

/** O(1) ref resolution; no log or branch enumeration in the per-file path. */
export class EditorBaselines {
  private queue = new EditorWorkQueue(4, 64);
  private contents = new Map<string, { content: string; bytes: number }>();
  private bytes = 0;
  private requests = new Map<
    string,
    { promise: Promise<string>; controller: AbortController; users: number }
  >();

  private shared(
    key: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> {
    let entry = this.requests.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      const deadline = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(15_000),
      ]);
      const promise = this.queue.run(deadline, () => operation(deadline));
      entry = { promise, controller, users: 0 };
      this.requests.set(key, entry);
      const owner = entry;
      void promise
        .finally(() => {
          if (this.requests.get(key) === owner) this.requests.delete(key);
        })
        .catch(() => undefined);
    }
    entry.users++;
    const current = entry;
    return waitForEditorWork(entry.promise, signal).finally(() => {
      if (--current.users === 0) current.controller.abort();
    });
  }

  private git(
    worktree: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', worktree, ...args],
        {
          signal,
          killSignal: 'SIGKILL',
          timeout: 15_000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: buildAugmentedEnv(process.env, worktree),
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  status(worktree: string, signal?: AbortSignal): Promise<string> {
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    return this.shared(`${path.resolve(worktree)}\0status`, deadline, (abort) =>
      this.git(
        worktree,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        abort,
      ),
    );
  }

  async read(
    worktree: string,
    ref: string,
    file: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(15_000),
    ]);
    const root = path.resolve(worktree);
    const sha = /^[a-f0-9]{40,64}$/i.test(ref)
      ? ref
      : (
          await this.shared(`${root}\0ref:${ref}`, deadline, (abort) =>
            this.git(root, ['rev-parse', '--verify', `${ref}^{commit}`], abort),
          )
        ).trim();
    const key = `${root}\0${sha}\0${file}`;
    const cached = this.contents.get(key);
    if (cached) {
      this.contents.delete(key);
      this.contents.set(key, cached);
      return cached.content;
    }
    return this.shared(key, deadline, async (abort) => {
      const content = await this.git(root, ['show', `${sha}:${file}`], abort);
      const bytes = Buffer.byteLength(content);
      if (bytes <= 2 * 1024 * 1024) {
        while (
          this.bytes + bytes > 16 * 1024 * 1024 ||
          this.contents.size >= 256
        ) {
          const oldest = this.contents.keys().next().value!;
          this.bytes -= this.contents.get(oldest)!.bytes;
          this.contents.delete(oldest);
        }
        this.contents.set(key, { content, bytes });
        this.bytes += bytes;
      }
      return content;
    });
  }
}
