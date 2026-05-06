import { EventEmitter } from 'events';

export type LogLevel =
  | 'debug'
  | 'error'
  | 'fatal'
  | 'info'
  | 'log'
  | 'trace'
  | 'verbose'
  | 'warn';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

let intercepted = false;
let activeConsoleLevel: LogLevel | null = null;

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const NEST_LOG_LEVELS: Record<string, LogLevel> = {
  DEBUG: 'debug',
  ERROR: 'error',
  FATAL: 'fatal',
  LOG: 'log',
  VERBOSE: 'verbose',
  WARN: 'warn',
};

function stripAnsi(message: string): string {
  return message.replace(ANSI_PATTERN, '');
}

function normalizeLogLevel(level: unknown): LogLevel | null {
  if (typeof level !== 'string') return null;

  switch (level.toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'error':
      return 'error';
    case 'fatal':
      return 'fatal';
    case 'info':
      return 'info';
    case 'log':
      return 'log';
    case 'trace':
      return 'trace';
    case 'verbose':
      return 'verbose';
    case 'warn':
    case 'warning':
      return 'warn';
    default:
      return null;
  }
}

export function inferLogLevelFromMessage(message: string): LogLevel | null {
  const plainMessage = stripAnsi(message);
  const trimmedMessage = plainMessage.trim();

  const nestLevel = trimmedMessage.match(
    /^\[Nest\]\s+\d+\s+-\s+.*?\b(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\b/,
  )?.[1];
  if (nestLevel) {
    return NEST_LOG_LEVELS[nestLevel] ?? null;
  }

  try {
    const parsed = JSON.parse(trimmedMessage) as { level?: unknown };
    return normalizeLogLevel(parsed.level);
  } catch {
    return null;
  }
}

function emitLog(level: LogLevel, chunk: Uint8Array | string): void {
  const message =
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
  if (!message.trim()) return;

  logEmitter.emit('log', {
    level: inferLogLevelFromMessage(message) ?? activeConsoleLevel ?? level,
    message: message.replace(/\n$/, ''),
    timestamp: new Date().toISOString(),
  } satisfies LogEntry);
}

function withConsoleLevel<T>(level: LogLevel, callback: () => T): T {
  const previousLevel = activeConsoleLevel;
  activeConsoleLevel = level;
  try {
    return callback();
  } finally {
    activeConsoleLevel = previousLevel;
  }
}

function interceptConsoleMethods(): void {
  const methods = [
    ['debug', 'debug'],
    ['error', 'error'],
    ['info', 'info'],
    ['log', 'log'],
    ['trace', 'trace'],
    ['warn', 'warn'],
  ] as const satisfies ReadonlyArray<readonly [keyof Console, LogLevel]>;

  for (const [method, level] of methods) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) =>
      withConsoleLevel(level, () =>
        original(...args),
      )) as (typeof console)[typeof method];
  }
}

export function interceptProcessStreams(): void {
  if (intercepted) return;
  intercepted = true;
  interceptConsoleMethods();

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    emitLog('log', chunk);
    return typeof encodingOrCb === 'function'
      ? origStdoutWrite(chunk, encodingOrCb)
      : origStdoutWrite(chunk, encodingOrCb as BufferEncoding | undefined, cb);
  } as typeof process.stdout.write;

  (process.stderr as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    emitLog('error', chunk);
    return typeof encodingOrCb === 'function'
      ? origStderrWrite(chunk, encodingOrCb)
      : origStderrWrite(chunk, encodingOrCb as BufferEncoding | undefined, cb);
  } as typeof process.stderr.write;
}
