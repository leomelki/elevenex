/** Shared by the local SSH adapter and the uploaded, plain-Node bridge. */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { Socket } from 'node:net';

export type WireMessage =
  | { type: 'hello'; version: string; instance: string; ready: boolean; agentForwarding: boolean }
  | { type: 'ping' | 'pong'; id: number; ready?: boolean; instance?: string }
  | { type: 'open'; id: number; port: number }
  | { type: 'probe'; id: number; port: number }
  | { type: 'probed'; id: number; available: boolean }
  | { type: 'opened' | 'ack' | 'end' | 'close' | 'error'; id: number }
  | { type: 'data'; id: number; data: string };
const MAX_LINE = 96 * 1024;

function message(value: unknown): WireMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid bridge frame');
  const input = value as Record<string, unknown>;
  const type = input['type'];
  if (type === 'hello') {
    if (typeof input['version'] !== 'string' || !/^[a-f0-9]{40}$/.test(input['version'])
      || typeof input['instance'] !== 'string' || input['instance'].length > 64 || typeof input['ready'] !== 'boolean' || typeof input['agentForwarding'] !== 'boolean') throw new Error('Invalid bridge greeting');
  } else {
    if (!Number.isSafeInteger(input['id']) || Number(input['id']) < 1) throw new Error('Invalid bridge sequence');
    if (type === 'open' || type === 'probe') {
      if (!Number.isInteger(input['port']) || Number(input['port']) < 0 || Number(input['port']) > 65535) throw new Error('Invalid remote port');
    } else if (type === 'data') {
      if (typeof input['data'] !== 'string' || input['data'].length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input['data'])) throw new Error('Invalid bridge data');
    } else if (type === 'probed') {
      if (typeof input['available'] !== 'boolean') throw new Error('Invalid service probe');
    } else if (type === 'pong') {
      if (typeof input['ready'] !== 'boolean' || typeof input['instance'] !== 'string' || input['instance'].length > 64) throw new Error('Invalid health reply');
    } else if (!['ping', 'opened', 'ack', 'end', 'close', 'error'].includes(String(type))) throw new Error('Unknown bridge message');
  }
  return value as WireMessage;
}

/** Bounded frames and aggregate output; a slow reader cannot grow memory indefinitely. */
export class Wire extends EventEmitter {
  private buffered = Buffer.alloc(0);
  private closed = false;
  private readonly data = (chunk: Buffer) => {
    try {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      while (true) {
        const index = this.buffered.indexOf(10);
        if (index < 0) break;
        if (index > MAX_LINE) throw new Error('Bridge frame exceeds its limit');
        const line = this.buffered.subarray(0, index).toString('utf8');
        this.buffered = this.buffered.subarray(index + 1);
        this.emit('message', message(JSON.parse(line)));
      }
      if (this.buffered.length > MAX_LINE) throw new Error('Bridge frame exceeds its limit');
    } catch { this.close(); }
  };
  private readonly ended = () => this.close();
  constructor(private readonly input: Readable, private readonly output: Writable) {
    super();
    input.on('data', this.data);
    input.once('end', this.ended); input.once('error', this.ended); output.once('error', this.ended);
  }
  send(value: WireMessage): void {
    if (this.closed) throw new Error('Bridge is closed');
    if (this.output.writableLength > 4 * 1024 * 1024) { this.close(); throw new Error('Bridge output exceeded its limit'); }
    this.output.write(`${JSON.stringify(value)}\n`);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener('data', this.data);
    this.input.removeListener('end', this.ended); this.input.removeListener('error', this.ended); this.output.removeListener('error', this.ended);
    this.buffered = Buffer.alloc(0);
    this.emit('closed');
    this.removeAllListeners();
  }
}

/** One in-flight data frame per direction, acknowledged after the socket drains. */
export class SocketChannels {
  private readonly channels = new Map<number, { socket: Socket; timer: ReturnType<typeof setTimeout>; sending: boolean; receiving: boolean; opened: boolean; onOpen?: (available: boolean) => void }>();
  private sequence = 0;
  private readonly receive = (frame: WireMessage) => {
    if (!('id' in frame)) return;
    const entry = this.channels.get(frame.id);
    if (!entry) return;
    if (frame.type === 'data') {
      if (entry.receiving) { this.closeChannel(frame.id); return; }
      entry.receiving = true;
      entry.socket.write(Buffer.from(frame.data, 'base64'), () => {
        entry.receiving = false;
        if (this.channels.has(frame.id)) this.send({ type: 'ack', id: frame.id });
      });
    } else if (frame.type === 'ack' || frame.type === 'opened') {
      if (frame.type === 'opened') { clearTimeout(entry.timer); entry.opened = true; entry.onOpen?.(true); }
      entry.sending = false;
      entry.socket.resume();
    } else if (frame.type === 'end') entry.socket.end();
    else if (frame.type === 'close' || frame.type === 'error') this.closeChannel(frame.id, false);
  };
  private readonly closed = () => this.dispose();
  constructor(private readonly wire: Wire) { wire.on('message', this.receive); wire.once('closed', this.closed); }

  open(socket: Socket, port: number, onOpen?: (available: boolean) => void): void {
    const id = ++this.sequence;
    if (!this.attach(id, socket, true, onOpen)) return;
    this.send({ type: 'open', id, port });
  }
  accept(id: number, port: number, backendSocket: string): void {
    if (this.channels.has(id)) { this.wire.close(); return; }
    const socket = new Socket();
    if (!this.attach(id, socket, false)) return;
    socket.once('connect', () => { if (this.channels.has(id)) this.send({ type: 'opened', id }); });
    if (port === 0) socket.connect(backendSocket); else socket.connect(port, '127.0.0.1');
  }
  private send(frame: WireMessage): void {
    try { this.wire.send(frame); } catch { this.dispose(); }
  }
  private attach(id: number, socket: Socket, opening: boolean, onOpen?: (available: boolean) => void): boolean {
    if (this.channels.size >= 64) { socket.destroy(); onOpen?.(false); this.send({ type: 'error', id }); return false; }
    socket.pause();
    const timer = setTimeout(() => this.closeChannel(id), 10_000);
    const entry = { socket, timer, sending: opening, receiving: false, opened: !opening, onOpen };
    this.channels.set(id, entry);
    if (!opening) socket.once('connect', () => { clearTimeout(timer); socket.resume(); });
    socket.on('data', (bytes: Buffer) => {
      if (entry.sending || bytes.length > 64 * 1024) { this.closeChannel(id); return; }
      entry.sending = true;
      socket.pause();
      this.send({ type: 'data', id, data: bytes.toString('base64') });
    });
    socket.once('end', () => this.send({ type: 'end', id }));
    socket.once('error', () => this.closeChannel(id));
    socket.once('close', () => this.closeChannel(id));
    return true;
  }
  private closeChannel(id: number, notify = true): void {
    const entry = this.channels.get(id);
    if (!entry) return;
    this.channels.delete(id);
    clearTimeout(entry.timer);
    entry.socket.destroy();
    if (!entry.opened) entry.onOpen?.(false);
    if (notify) this.send({ type: 'close', id });
  }
  dispose(): void {
    this.wire.removeListener('message', this.receive); this.wire.removeListener('closed', this.closed);
    for (const id of this.channels.keys()) this.closeChannel(id, false);
  }
}
