import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CRASH_LOG_DIR = join(homedir(), '.elevenex', 'logs');
const RING_BUFFER_SIZE = 50;

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

const ringBuffer: LogEntry[] = [];

function pushToRingBuffer(entry: LogEntry): void {
  if (ringBuffer.length >= RING_BUFFER_SIZE) ringBuffer.shift();
  ringBuffer.push(entry);
}

function writeCrashLog(reason: string, error: unknown): void {
  try {
    mkdirSync(CRASH_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(CRASH_LOG_DIR, `crash-${ts}.log`);
    const errorText =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error);
    const recentLines = ringBuffer
      .map((e) => `[${e.timestamp}] ${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
    writeFileSync(
      filePath,
      `CRASH: ${reason}\n${errorText}\n\n--- last ${ringBuffer.length} log lines ---\n${recentLines}\n`,
      'utf8',
    );
  } catch {
    // best-effort: if we can't write the crash log, there's nothing we can do
  }
}

let crashHandlersInstalled = false;

function installCrashHandlers(): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;

  process.on('uncaughtException', (error) => {
    writeCrashLog('uncaughtException', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    writeCrashLog('unhandledRejection', reason);
  });
}

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

  const entry: LogEntry = {
    level: inferLogLevelFromMessage(message) ?? activeConsoleLevel ?? level,
    message: message.replace(/\n$/, ''),
    timestamp: new Date().toISOString(),
  };
  pushToRingBuffer(entry);
  logEmitter.emit('log', entry);
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
  installCrashHandlers();

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
      : origStdoutWrite(chunk, encodingOrCb, cb);
  };

  (process.stderr as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    emitLog('error', chunk);
    return typeof encodingOrCb === 'function'
      ? origStderrWrite(chunk, encodingOrCb)
      : origStderrWrite(chunk, encodingOrCb, cb);
  };
}
