import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { TaskAppInput } from '@elevenex/shared';
import { RuntimeVideoHost } from '../desktop-browser/runtime-video-host.js';
import {
  DisplayCapture,
  type AppFrameListener,
  type AppStreamEnd,
} from './display-capture.js';

const exec = promisify(execFile);
export function windowsAppHelper(): string {
  const root = process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  if (!root || !isAbsolute(root))
    throw new Error(
      'A managed Windows backend with the app display helper is required',
    );
  return join(root, 'bin', 'task-app-windows.exe');
}

export async function windowsAppJobDrained(runId: string): Promise<boolean> {
  const { stdout } = await exec(windowsAppHelper(), ['--job-drained', runId], {
    windowsHide: true,
    timeout: 2500,
    maxBuffer: 1024,
  });
  return stdout.trim() === 'drained';
}

const keys: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumLock: 144,
  ScrollLock: 145,
  ShiftLeft: 160,
  ShiftRight: 161,
  ControlLeft: 162,
  ControlRight: 163,
  AltLeft: 164,
  AltRight: 165,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
};

function keycode(code: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.at(-1));
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code))
    return 111 + Number(code.slice(1));
  if (!Object.hasOwn(keys, code))
    throw new Error('Unsupported Windows app key');
  return keys[code];
}

type Input = TaskAppInput | { kind: 'release' };
interface Geometry {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}
export function windowsInput(event: Input, size: Geometry): string {
  if (event.kind === 'release') return 'release';
  if (event.kind === 'key')
    return 'key ' + keycode(event.code) + ' ' + Number(event.down);
  if (event.kind === 'text') {
    if (!event.text || event.text.length > 256)
      throw new Error('Invalid committed text');
    let units = '';
    for (let i = 0; i < event.text.length; i++)
      units += event.text.charCodeAt(i).toString(16).padStart(4, '0');
    return 'text ' + units;
  }
  if (
    !Number.isInteger(event.x) ||
    !Number.isInteger(event.y) ||
    event.x < 0 ||
    event.y < 0 ||
    event.x >= size.width ||
    event.y >= size.height
  )
    throw new Error('Pointer outside Windows app');
  const x = Math.floor((event.x * size.sourceWidth) / size.width);
  const y = Math.floor((event.y * size.sourceHeight) / size.height);
  const prefix = event.kind + ' ' + x + ' ' + y;
  if (event.kind === 'wheel') {
    const delta = (value: number) =>
      Math.round(Math.max(-960, Math.min(960, value)));
    return prefix + ' ' + delta(event.deltaX) + ' ' + delta(event.deltaY);
  }
  if (event.kind === 'down' || event.kind === 'up')
    return prefix + ' ' + (event.button ?? 0);
  return prefix;
}

/** Windows Graphics Capture writes BGRA directly into a private FFmpeg pipe.
 * Each viewer receives encoded packets; only the verified run job is selectable. */
export class WindowsAppDisplay {
  private readonly viewers = new Map<
    AppFrameListener,
    (() => void) | undefined
  >();
  private source?: DisplayCapture;
  private child?: ChildProcessWithoutNullStreams;
  private encoderExitDeadline?: NodeJS.Timeout;
  private size?: Geometry;
  private id = 0;
  private readonly pending = new Map<number, (ok: boolean) => void>();
  constructor(
    private readonly runId: string,
    private readonly host: RuntimeVideoHost,
  ) {}

  static async preflight(): Promise<void> {
    try {
      await exec(windowsAppHelper(), ['--check'], {
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 2048,
      });
    } catch {
      throw new Error(
        'A logged-in, unlocked Windows 10 1903+ session with the managed app helper is required',
      );
    }
  }

  watch(listener: AppFrameListener): () => void {
    if (this.viewers.size >= 8) throw new Error('Too many app viewers');
    this.viewers.set(listener, undefined);
    try {
      if (this.source) this.attach(listener);
      else if (!this.child) this.start();
    } catch (error) {
      this.viewers.delete(listener);
      throw error;
    }
    return () => {
      const detach = this.viewers.get(listener);
      this.viewers.delete(listener);
      detach?.();
      if (!this.viewers.size) this.close('View closed');
    };
  }

  private attach(listener: AppFrameListener): void {
    const source = this.source;
    if (!source) return;
    this.viewers.set(
      listener,
      source.watch({
        frame: (frame) => listener.frame(frame),
        end: (reason) => {
          if (this.source !== source || this.encoderExitDeadline) return;
          // The native helper's exit code identifies resize, lock and window
          // closure. Its raw-video pipe can reach FFmpeg EOF before Node sees
          // that exit. Retire input immediately and let the owner report why.
          this.size = undefined;
          this.encoderExitDeadline = setTimeout(() => this.close(reason), 500);
          this.encoderExitDeadline.unref();
          if (this.child?.stdin.writable) this.child.stdin.end();
        },
      }),
    );
  }

  private start(): void {
    const pipe = randomUUID();
    const child = spawn(windowsAppHelper(), ['--view', this.runId, pipe], {
      windowsHide: true,
      stdio: 'pipe',
    });
    this.child = child;
    let errorMessage = '',
      tail = '';
    const fail = (reason: string, disposition?: AppStreamEnd) => {
      if (this.child === child) this.close(reason, disposition);
    };
    child.once('error', () =>
      fail('Windows app capture helper is unavailable'),
    );
    child.once('close', (code) => {
      const disposition =
        code === 20
          ? 'permission'
          : code === 22
            ? 'window-missing'
            : code === 23
              ? 'window-changed'
              : undefined;
      fail(errorMessage || 'Windows app display ended', disposition);
    });
    child.stdin.on('error', () => {
      if (!this.encoderExitDeadline) fail('App input disconnected');
    });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      errorMessage = (errorMessage + data).trim().slice(-320);
    });
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      if (this.child !== child) return;
      const lines = (tail + data).split('\n');
      tail = lines.pop()!;
      if (tail.length > 128) return fail('Invalid Windows capture reply');
      for (const item of lines) {
        const line = item.trim();
        const ack = /^ack ([1-9]\d{0,9}) ([01])$/.exec(line);
        if (ack) {
          const id = Number(ack[1]);
          this.pending.get(id)?.(ack[2] === '1');
          this.pending.delete(id);
          continue;
        }
        const dimensions = /^ready (\d{1,4}) (\d{1,4})$/.exec(line);
        if (!dimensions || this.source)
          return fail('Invalid Windows capture reply');
        const sourceWidth = Number(dimensions[1]),
          sourceHeight = Number(dimensions[2]);
        if (
          sourceWidth < 2 ||
          sourceHeight < 2 ||
          sourceWidth > 8192 ||
          sourceHeight > 8192 ||
          sourceWidth * sourceHeight > 16_777_216
        )
          return fail('App window exceeds capture limits');
        const scale = Math.min(
          1,
          1920 / sourceWidth,
          1920 / sourceHeight,
          Math.sqrt(2_073_600 / (sourceWidth * sourceHeight)),
        );
        const width = Math.max(16, 2 * Math.floor((sourceWidth * scale) / 2)),
          height = Math.max(16, 2 * Math.floor((sourceHeight * scale) / 2));
        this.size = { sourceWidth, sourceHeight, width, height };
        const env: NodeJS.ProcessEnv = {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
        };
        this.source = new DisplayCapture(
          {
            width,
            height,
            env,
            restartable: false,
            input: () => [
              '-f',
              'rawvideo',
              '-pixel_format',
              'bgra',
              '-framerate',
              '30',
              '-use_wallclock_as_timestamps',
              '1',
              '-video_size',
              sourceWidth + 'x' + sourceHeight,
              '-i',
              '\\\\.\\pipe\\elevenex-app-video-' + pipe,
            ],
          },
          this.host,
        );
        try {
          for (const viewer of this.viewers.keys()) this.attach(viewer);
        } catch {
          return fail('Could not start app video encoder');
        }
      }
    });
  }

  async input(event: Input): Promise<void> {
    const child = this.child;
    if (!child?.stdin.writable || !this.size || this.pending.size >= 32)
      throw new Error('Windows app input unavailable');
    const line = windowsInput(event, this.size);
    const id = ++this.id;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.close('Windows app input timed out'),
        5000,
      );
      this.pending.set(id, (ok) => {
        clearTimeout(timer);
        if (ok) resolve();
        else
          reject(
            new Error('The owned Windows window cannot receive this input'),
          );
      });
      child.stdin.write(id + ' ' + line + '\n');
    });
  }

  close(reason: string, disposition?: AppStreamEnd): void {
    const child = this.child,
      source = this.source,
      viewers = [...this.viewers.keys()];
    this.child = undefined;
    this.source = undefined;
    this.size = undefined;
    clearTimeout(this.encoderExitDeadline);
    this.encoderExitDeadline = undefined;
    this.viewers.clear();
    for (const complete of this.pending.values()) complete(false);
    this.pending.clear();
    child?.kill();
    source?.close(reason);
    for (const listener of viewers) listener.end(reason, disposition);
  }
}
