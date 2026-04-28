import { EventEmitter } from 'events';

export interface LogEntry {
  level: 'log' | 'error';
  message: string;
  timestamp: string;
}

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

let intercepted = false;

export function interceptProcessStreams(): void {
  if (intercepted) return;
  intercepted = true;

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  (process.stdout as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const message = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (message.trim()) {
      logEmitter.emit('log', {
        level: 'log',
        message: message.replace(/\n$/, ''),
        timestamp: new Date().toISOString(),
      } satisfies LogEntry);
    }
    return typeof encodingOrCb === 'function'
      ? origStdoutWrite(chunk, encodingOrCb)
      : origStdoutWrite(chunk, encodingOrCb as BufferEncoding | undefined, cb);
  } as typeof process.stdout.write;

  (process.stderr as NodeJS.WriteStream).write = function (
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const message = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (message.trim()) {
      logEmitter.emit('log', {
        level: 'error',
        message: message.replace(/\n$/, ''),
        timestamp: new Date().toISOString(),
      } satisfies LogEntry);
    }
    return typeof encodingOrCb === 'function'
      ? origStderrWrite(chunk, encodingOrCb)
      : origStderrWrite(chunk, encodingOrCb as BufferEncoding | undefined, cb);
  } as typeof process.stderr.write;
}
