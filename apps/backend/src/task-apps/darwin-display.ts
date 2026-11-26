import { execFile, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  APP_INPUT_GUIDANCE,
  APP_VIDEO_MAX_AXIS,
  APP_VIDEO_MAX_PIXELS,
  APP_VIDEO_MAX_BYTES,
  type TaskAppInput,
  type TaskAppSetupIssue,
  type TaskAppSetupHelper,
} from '@elevenex/shared';
import type { AppFrameListener, AppStreamEnd } from './display-capture.js';
import { AppSetupError } from './app-setup-error.js';

const exec = promisify(execFile);
const limit = APP_VIDEO_MAX_BYTES;

function agentBundlePath(): string {
  const root = process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  if (!root || !root.startsWith('/'))
    throw new AppSetupError('macos-runtime',
      'A managed macOS backend with the app display helper is required',
    );
  return join(root, 'bin', 'Elevenex Agent.app');
}

function helperPath(): string {
  return join(agentBundlePath(), 'Contents', 'MacOS', 'Elevenex Agent');
}

function errorForCode(code: unknown): string {
  switch (code) {
    case 20:
      return 'Sign in and unlock the graphical session on the task Mac.';
    case 21:
      return 'Allow Screen Recording for Elevenex Agent on the task Mac, then retry the stream.';
    case 22:
      return 'Waiting for an owned, visible app window on the task Mac. Retry when its build is ready.';
    case 23:
      return 'App window or display geometry changed. Reopen the stream.';
    case 24:
      return 'The Mac could not capture or encode the app window. Resize the app or update its engine, then reconnect.';
    case 25:
      return 'Elevenex Agent could not connect to the task Mac’s desktop. Sign in and unlock the same account, then retry.';
    default:
      return 'The macOS display helper is unavailable. Verify the host runtime and screen recording permission.';
  }
}

function preflightError(code: unknown): AppSetupError {
  return new AppSetupError(
    code === 20 ? 'macos-session' : code === 21 ? 'macos-screen-recording' : code === 25 ? 'macos-desktop-connection' : 'macos-runtime',
    errorForCode(code),
  );
}

function exitCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

export type DarwinAppSession = 'user' | 'direct';

/** Use the logged-in account's bootstrap context, without changing user or privileges. */
export function darwinAppCommand(
  command: { executable: string; args: readonly string[] },
  session: DarwinAppSession,
) {
  if (session === 'direct') return command;
  const uid = process.getuid?.();
  if (!uid)
    throw new AppSetupError('macos-session',
      'App streaming requires a signed-in, unprivileged macOS account.',
    );
  return {
    executable: '/bin/launchctl',
    args: ['asuser', String(uid), command.executable, ...command.args],
  };
}

/** The signed native helper owns ScreenCaptureKit + VideoToolbox; Node receives only encoded access units. */
export class DarwinAppDisplay {
  private readonly channel: Duplex;
  private readonly listeners = new Map<AppFrameListener, boolean>();
  private readonly controls = new Map<number, (result: number) => void>();
  private nextControl = 0;
  private attached = false;
  private generation = 0;

  constructor(child: Pick<ChildProcess, 'stdio'>) {
    const channel = child.stdio[4];
    if (!(channel instanceof Duplex))
      throw new Error('Private macOS app display channel unavailable');
    this.channel = channel;
    this.receive();
    channel.once('error', () => this.end('App display connection ended'));
    channel.once('close', () => this.end('App display connection ended'));
  }

  static launchCommand(
    command: { executable: string; args: readonly string[] },
    session: DarwinAppSession,
    stream = true,
  ) {
    return darwinAppCommand(
      {
        executable: helperPath(),
        args: [stream ? '--launch-desktop' : '--launch', command.executable, ...command.args],
      },
      session,
    );
  }

  static async preflight(): Promise<DarwinAppSession> {
    const command = { executable: helperPath(), args: ['--check'] };
    const options = {
      timeout: 8000,
      maxBuffer: 1024,
      env: { PATH: '/usr/bin:/bin' },
    };
    try {
      await exec(command.executable, command.args, options);
      return 'direct';
    } catch (error) {
      // The native check uses LaunchServices, as does the real stream. An SSH
      // spawn or launchctl asuser retains SSH's TCC responsibility, so it must
      // not stand in for the agent whose permissions setup actually checked.
      throw preflightError(exitCode(error));
    }
  }

  static async openSetupSettings(): Promise<void> {
    // LaunchServices creates the setup UI in the logged-in desktop. Do not
    // run AppKit through launchctl asuser from the SSH audit session.
    await exec('/usr/bin/open', ['-n', '-a', agentBundlePath(), '--args', '--setup'], {
      timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' },
    });
  }

  static async revealSetupHelper(): Promise<TaskAppSetupHelper> {
    const path = agentBundlePath();
    // LaunchServices can reveal the installed file even when SSH cannot join
    // the graphical audit session. Never accept a path or URL from the viewer.
    const revealed = await exec('/usr/bin/open', ['-R', path], {
      timeout: 3000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' },
    }).then(() => true, () => false);
    return { path, revealed };
  }

  watch(listener: AppFrameListener): () => void {
    if (this.listeners.size >= 8) throw new Error('Too many app viewers');
    this.listeners.set(listener, false);
    if (this.listeners.size === 1) {
      const generation = ++this.generation;
      // A ready receipt and the first IDR may share one read from the helper.
      void this.send({ kind: 'watch' }, () => {
        if (this.generation === generation) this.attached = true;
      }).catch(() => {
        if (this.generation === generation) this.end('App capture unavailable');
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close('View closed');
    };
  }

  input(event: TaskAppInput | { kind: 'release' }): Promise<void> {
    if (!this.attached && event.kind !== 'release')
      return Promise.reject(new Error('Waiting for app capture'));
    return this.send(event);
  }

  private send(
    message: { kind: string },
    accepted?: () => void,
  ): Promise<void> {
    if (
      !this.channel.writable ||
      this.channel.writableEnded ||
      this.controls.size >= 32
    )
      return Promise.reject(new Error('App control unavailable'));
    const id = ++this.nextControl;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error('App control timed out'));
        this.end('App control interrupted');
      }, 5000);
      this.controls.set(id, (result) => {
        clearTimeout(timeout);
        if (result === 1) {
          accepted?.();
          resolve();
        } else {
          const message =
            result === 2
              ? APP_INPUT_GUIDANCE.permission
              : result === 3
                ? APP_INPUT_GUIDANCE.foreground
                : result === 4
                  ? APP_INPUT_GUIDANCE.window
                  : 'App input unavailable';
          reject(result === 2 ? new AppSetupError('macos-accessibility', message) : new Error(message));
        }
      });
      this.channel.write(JSON.stringify({ id, ...message }) + '\n', (error) => {
        if (error) {
          this.controls.get(id)?.(0);
          this.controls.delete(id);
        }
      });
    });
  }

  private receive(): void {
    // fd4 carries bounded native video packets; a zero-size packet is an input receipt or a display lifecycle notice.
    const header = Buffer.alloc(9);
    let headerBytes = 0,
      data: Buffer | undefined,
      written = 0;
    this.channel.on('data', (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; ) {
        if (!data) {
          const count = chunk.copy(
            header,
            headerBytes,
            offset,
            offset + 9 - headerBytes,
          );
          offset += count;
          headerBytes += count;
          if (headerBytes < 9) continue;
          const size = header.readUInt32BE();
          if (!size) {
            headerBytes = 0;
            const id = header.readUInt32BE(4),
              flag = header[8];
            if (!id) {
              const disposition =
                flag === 20 || flag === 21 || flag === 25
                  ? 'permission'
                  : flag === 22
                    ? 'window-missing'
                    : flag === 23
                      ? 'window-changed'
                      : flag === 24
                        ? 'capture-failed'
                        : undefined;
              const setupIssue = flag === 20 ? 'macos-session' : flag === 21 ? 'macos-screen-recording' : flag === 25 ? 'macos-desktop-connection' : undefined;
              this.end(errorForCode(flag), disposition, setupIssue);
            } else {
              this.controls.get(id)?.(flag);
              this.controls.delete(id);
            }
            continue;
          }
          const width = header.readUInt16BE(4),
            height = header.readUInt16BE(6);
          if (
            !size ||
            size > limit ||
            !width ||
            !height ||
            width > APP_VIDEO_MAX_AXIS ||
            height > APP_VIDEO_MAX_AXIS ||
            width * height > APP_VIDEO_MAX_PIXELS ||
            header[8] > 1
          ) {
            this.channel.destroy();
            this.end('Invalid macOS video packet');
            return;
          }
          data = Buffer.allocUnsafe(size);
          written = 0;
        }
        const count = chunk.copy(
          data,
          written,
          offset,
          offset + data.length - written,
        );
        offset += count;
        written += count;
        if (written === data.length) {
          const key = header[8] === 1;
          const frame = {
            data,
            key,
            width: header.readUInt16BE(4),
            height: header.readUInt16BE(6),
            codec: 'avc1.42E02A' as const,
            timestamp: Math.round(performance.now() * 1000),
          };
          for (const [listener, ready] of this.listeners) {
            if (!this.attached || (!key && !ready)) continue;
            this.listeners.set(listener, true);
            listener.frame(frame);
          }
          headerBytes = 0;
          data = undefined;
        }
      }
    });
  }

  close(reason: string): void {
    this.end(reason);
    void this.send({ kind: 'unwatch' }).catch(() => undefined);
  }

  private end(reason: string, disposition?: AppStreamEnd, setupIssue?: TaskAppSetupIssue): void {
    this.generation++;
    this.attached = false;
    for (const done of this.controls.values()) done(0);
    this.controls.clear();
    const listeners = [...this.listeners.keys()];
    this.listeners.clear();
    for (const listener of listeners) listener.end(reason, disposition, setupIssue);
  }
}
