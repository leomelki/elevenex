/** Shared by the local SSH adapter and the uploaded, plain-Node bridge. */
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { Socket, isIP } from 'node:net';
import type { BrowserSocketTarget } from '@elevenex/browser-network';

export type WireMessage =
  | { type: 'hello'; version: string; instance: string; ready: boolean; agentForwarding: boolean; browserProxy?: true; appViewerAccess?: string; appBinary?: true; session?: 'desktop' | 'background' }
  | { type: 'desktop-session'; id: number }
  | { type: 'desktop-session-result'; id: number; outcome: 'switching' | 'signed-out' }
  | { type: 'update-waiting'; instance: string; connections: number | null }
  | { type: 'update-starting'; instance: string }
  | { type: 'force-update'; instance: string }
  | { type: 'ping' | 'pong'; id: number; ready?: boolean; instance?: string }
  | { type: 'open'; id: number; port: number; host?: string; appBinary?: true }
  | { type: 'browser-open'; id: number; port: number; host: string }
  | { type: 'probe'; id: number; port: number; host?: string }
  | { type: 'probed'; id: number; available: boolean }
  | { type: 'opened' | 'end' | 'close' | 'error'; id: number }
  | { type: 'ack'; id: number; bytes: number }
  | { type: 'data'; id: number; data: string | Buffer };
const MAX_LINE = 96 * 1024;

function message(value: unknown): WireMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid bridge frame');
  const input = value as Record<string, unknown>;
  const type = input['type'];
  if (type === 'hello') {
    if (typeof input['version'] !== 'string' || !/^[a-f0-9]{40}$/.test(input['version'])
      || typeof input['instance'] !== 'string' || input['instance'].length > 64 || typeof input['ready'] !== 'boolean' || typeof input['agentForwarding'] !== 'boolean') throw new Error('Invalid bridge greeting');
    if (input['appBinary'] !== undefined && input['appBinary'] !== true) throw new Error('Invalid media capability');
    if (input['appViewerAccess'] !== undefined && (typeof input['appViewerAccess'] !== 'string' || !/^[a-f0-9]{64}$/.test(input['appViewerAccess']))) throw new Error('Invalid app viewer credential');
    if (input['browserProxy'] !== undefined && input['browserProxy'] !== true) throw new Error('Invalid browser proxy capability');
    if (input['session'] !== undefined && input['session'] !== 'desktop' && input['session'] !== 'background') throw new Error('Invalid Windows session');
  } else if (type === 'update-waiting' || type === 'update-starting' || type === 'force-update') {
    if (typeof input['instance'] !== 'string' || !/^[a-f0-9-]{36}$/.test(input['instance'])) throw new Error('Invalid update instance');
    const count = input['connections'];
    if (type === 'update-waiting' && count !== null && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 257)) throw new Error('Invalid update connection count');
  } else {
    if (!Number.isSafeInteger(input['id']) || Number(input['id']) < 1) throw new Error('Invalid bridge sequence');
    if (type === 'browser-open') {
      if (!Number.isInteger(input['port']) || Number(input['port']) < 1 || Number(input['port']) > 65535 || typeof input['host'] !== 'string' || !input['host'].length || input['host'].length > 253 || (!isIP(input['host']) && !/^[a-zA-Z0-9._-]+$/.test(input['host']))) throw new Error('Invalid browser destination');
    } else if (type === 'open' || type === 'probe') {
      if (!Number.isInteger(input['port']) || Number(input['port']) < 0 || Number(input['port']) > 65535) throw new Error('Invalid remote port');
      if (input['appBinary'] !== undefined && (type !== 'open' || input['port'] !== 0 || input['appBinary'] !== true)) throw new Error('Invalid media channel');
      const host = input['host'];
      if (host !== undefined && (typeof host !== 'string' || (host !== '::1' && !(isIP(host) === 4 && host.startsWith('127.'))))) throw new Error('Invalid remote loopback address');
    } else if (type === 'ack') {
      if (!Number.isInteger(input['bytes']) || Number(input['bytes']) < 1 || Number(input['bytes']) > 65536) throw new Error('Invalid byte acknowledgement');
    } else if (type === 'data') {
      if (typeof input['data'] !== 'string' || input['data'].length > 87384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input['data'])) throw new Error('Invalid bridge data');
    } else if (type === 'probed') {
      if (typeof input['available'] !== 'boolean') throw new Error('Invalid service probe');
    } else if (type === 'desktop-session-result') {
      if (input['outcome'] !== 'switching' && input['outcome'] !== 'signed-out') throw new Error('Invalid desktop session reply');
    } else if (type === 'pong') {
      if (typeof input['ready'] !== 'boolean' || typeof input['instance'] !== 'string' || input['instance'].length > 64) throw new Error('Invalid health reply');
    } else if (!['ping', 'opened', 'end', 'close', 'error', 'desktop-session'].includes(String(type))) throw new Error('Unknown bridge message');
  }
  return value as WireMessage;
}

/** Bounded frames and aggregate output; a slow reader cannot grow memory indefinitely. */
export class Wire extends EventEmitter {
  private buffered: Buffer = Buffer.alloc(0);
  private partialMedia?: { id: number; bytes: Buffer; offset: number };
  private closed = false;
  private received = 0;
  private readonly data = (chunk: Buffer) => {
    this.received = Date.now();
    try {
      if (this.partialMedia) {
        const packet = this.partialMedia;
        const copied = chunk.copy(packet.bytes, packet.offset);
        packet.offset += copied;
        if (packet.offset < packet.bytes.length) return;
        this.partialMedia = undefined;
        this.emit('message', { type: 'data', id: packet.id, data: packet.bytes });
        if (this.closed || copied === chunk.length) return;
        chunk = chunk.subarray(copied);
      }
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
      while (true) {
        if (this.buffered[0] === 0) {
          if (this.buffered.length < 9) break;
          const id = this.buffered.readUInt32BE(1);
          const length = this.buffered.readUInt32BE(5);
          if (!id || !length || length > CHUNK_BYTES) throw new Error('Invalid media frame');
          if (this.buffered.length < 9 + length) {
            // SSH may deliver a large packet in many small fragments. Fill one
            // bounded allocation instead of repeatedly recopying the prefix.
            const bytes = Buffer.allocUnsafe(length);
            this.partialMedia = { id, bytes, offset: this.buffered.copy(bytes, 0, 9) };
            this.buffered = Buffer.alloc(0);
            break;
          }
          const data = this.buffered.subarray(9, 9 + length);
          this.buffered = this.buffered.subarray(9 + length);
          this.emit('message', { type: 'data', id, data });
          continue;
        }
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
  private readonly drained = () => this.emit('drain');
  /** Time of the latest inbound bytes, including bulk frames queued ahead of a reply. */
  get receivedAt(): number { return this.received; }
  get writable(): boolean { return !this.closed && !this.output.writableNeedDrain; }
  constructor(private readonly input: Readable, private readonly output: Writable) {
    super();
    input.on('data', this.data); output.on('drain', this.drained);
    input.once('end', this.ended); input.once('error', this.ended); output.once('error', this.ended);
  }
  send(value: WireMessage): void {
    if (this.closed) throw new Error('Bridge is closed');
    if (this.output.writableLength > 4 * 1024 * 1024) { this.close(); throw new Error('Bridge output exceeded its limit'); }
    if (value.type === 'data' && Buffer.isBuffer(value.data)) {
      if (value.id < 1 || value.id > 0xffffffff || !value.data.length || value.data.length > CHUNK_BYTES)
        throw new Error('Invalid media frame');
      const frame = Buffer.allocUnsafe(9 + value.data.length);
      frame[0] = 0;
      frame.writeUInt32BE(value.id, 1);
      frame.writeUInt32BE(value.data.length, 5);
      value.data.copy(frame, 9);
      this.output.write(frame);
      return;
    }
    this.output.write(`${JSON.stringify(value)}\n`);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.partialMedia = undefined;
    this.input.removeListener('data', this.data);
    this.input.removeListener('end', this.ended); this.input.removeListener('error', this.ended); this.output.removeListener('error', this.ended);
    this.output.removeListener('drain', this.drained);
    this.buffered = Buffer.alloc(0);
    this.emit('closed');
    this.removeAllListeners();
  }
}

const CHUNK_BYTES = 64 * 1024;
const WINDOW_BYTES = 512 * 1024;
interface SocketChannel {
  appBinary: boolean;
  socket: Socket;
  timer: ReturnType<typeof setTimeout>;
  sent: number;
  receiving: number;
  opened: boolean;
  localEnded: boolean;
  remoteEnded: boolean;
  socketClosed: boolean;
  onOpen?: (available: boolean) => void;
}

/** Byte credits bound memory while allowing several frames per network round trip. */
export class SocketChannels {
  private readonly channels = new Map<number, SocketChannel>();
  private sequence = 0;
  private lastWriter?: number;
  private readonly receive = (frame: WireMessage) => {
    if (!('id' in frame)) return;
    const entry = this.channels.get(frame.id);
    if (!entry) return;
    if (frame.type === 'data') {
      if (Buffer.isBuffer(frame.data) && !entry.appBinary) { this.closeChannel(frame.id); return; }
      const bytes = typeof frame.data === 'string' ? Buffer.from(frame.data, 'base64') : frame.data;
      if (!entry.opened || !bytes.length || bytes.length > CHUNK_BYTES || entry.remoteEnded || entry.receiving + bytes.length > WINDOW_BYTES) { this.closeChannel(frame.id); return; }
      entry.receiving += bytes.length;
      entry.socket.write(bytes, error => {
        entry.receiving -= bytes.length;
        if (!this.channels.has(frame.id)) return;
        if (error) { this.closeChannel(frame.id); return; }
        this.send({ type: 'ack', id: frame.id, bytes: bytes.length });
        this.finish(frame.id, entry);
      });
    } else if (frame.type === 'ack') {
      if (frame.bytes > entry.sent) { this.closeChannel(frame.id); return; }
      entry.sent -= frame.bytes;
      this.pump(frame.id, entry); this.finish(frame.id, entry);
    } else if (frame.type === 'opened') {
      if (entry.opened) { this.closeChannel(frame.id); return; }
      clearTimeout(entry.timer); entry.opened = true; entry.onOpen?.(true); this.pump(frame.id, entry);
    } else if (frame.type === 'end') {
      entry.remoteEnded = true; entry.socket.end();
    } else if (frame.type === 'close' || frame.type === 'error') this.closeChannel(frame.id, false);
  };
  private readonly closed = () => this.dispose();
  private readonly drained = () => {
    // Resume after the prior writer. A hot app stream must yield the next
    // available SSH write to a waiting editor, terminal or HTTP operation.
    const entries = [...this.channels];
    const start = entries.findIndex(([id]) => id === this.lastWriter) + 1;
    for (let i = 0; i < entries.length && this.wire.writable; i++) {
      const [id, entry] = entries[(start + i) % entries.length]!;
      this.pump(id, entry);
    }
  };
  constructor(private readonly wire: Wire) {
    wire.on('message', this.receive); wire.once('closed', this.closed); wire.on('drain', this.drained);
  }

  open(socket: Socket, port: number, onOpen?: (available: boolean) => void, host?: string, appBinary = false): void {
    const id = ++this.sequence;
    if (this.attach(id, socket, onOpen, appBinary)) this.send({ type: 'open', id, port, ...(appBinary ? { appBinary: true } : {}), ...(host === undefined ? {} : { host }) });
  }
  openBrowser(socket: Socket, host: string, port: number, onOpen: (available: boolean) => void): void {
    const id = ++this.sequence;
    if (this.attach(id, socket, onOpen)) this.send({ type: 'browser-open', id, host, port });
  }
  acceptBrowser(id: number, host: string, port: number, resolve: (host: string, port: number) => Promise<BrowserSocketTarget>): void {
    if (this.channels.has(id)) { this.wire.close(); return; }
    const socket = new Socket({ allowHalfOpen: true });
    if (!this.attach(id, socket)) return;
    void resolve(host, port).then(target => {
      if (this.channels.get(id)?.socket !== socket) return;
      socket.once('connect', () => {
        const entry = this.channels.get(id); if (!entry) return;
        clearTimeout(entry.timer); entry.opened = true;
        this.send({ type: 'opened', id }); this.pump(id, entry);
      });
      socket.connect({ host: target.host, port: target.port, ...(target.addresses ? {
        autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 200,
        lookup: (_host, options, callback) => {
          const addresses = target.addresses ?? [];
          if (!addresses.length) { callback(new Error('No browser destination'), []); return; }
          if (options.all) callback(null, [...addresses]);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
      } : {}) });
    }).catch(() => { if (this.channels.get(id)?.socket === socket) this.closeChannel(id); });
  }
  accept(id: number, port: number, backendSocket: string, host = '127.0.0.1', connectPrivate?: () => Socket, appBinary = false): void {
    if (this.channels.has(id)) { this.wire.close(); return; }
    const privatePipe = port === 0 && connectPrivate;
    const socket = privatePipe ? privatePipe() : new Socket({ allowHalfOpen: true });
    if (!this.attach(id, socket, undefined, appBinary)) return;
    socket.once(privatePipe ? 'secureConnect' : 'connect', () => {
      const entry = this.channels.get(id); if (!entry) return;
      clearTimeout(entry.timer); entry.opened = true;
      this.send({ type: 'opened', id }); this.pump(id, entry);
    });
    if (privatePipe) return;
    if (port === 0) socket.connect(backendSocket); else socket.connect(port, host);
  }
  private send(frame: WireMessage): void {
    try { this.wire.send(frame); } catch { this.dispose(); }
  }
  private pump(id: number, entry: SocketChannel): void {
    while (this.channels.get(id) === entry && entry.opened && !entry.localEnded && !entry.socketClosed && entry.sent < WINDOW_BYTES && this.wire.writable) {
      const size = Math.min(CHUNK_BYTES, WINDOW_BYTES - entry.sent, entry.socket.readableLength);
      // read(0) also delivers EOF when all buffered bytes have been consumed.
      if (!size) { entry.socket.read(0); return; }
      const bytes: Buffer | null = entry.socket.read(size);
      if (!bytes) return;
      entry.sent += bytes.length;
      this.lastWriter = id;
      this.send({ type: 'data', id, data: entry.appBinary ? bytes : bytes.toString('base64') });
    }
  }
  private attach(id: number, socket: Socket, onOpen?: (available: boolean) => void, appBinary = false): boolean {
    if (this.channels.size >= 64) { socket.destroy(); onOpen?.(false); this.send({ type: 'error', id }); return false; }
    socket.allowHalfOpen = true; socket.pause();
    const timer = setTimeout(() => this.closeChannel(id), 10_000);
    const entry: SocketChannel = { appBinary, socket, timer, sent: 0, receiving: 0, opened: false, localEnded: false, remoteEnded: false, socketClosed: false, onOpen };
    this.channels.set(id, entry);
    socket.on('readable', () => this.pump(id, entry));
    socket.once('end', () => { entry.localEnded = true; if (this.channels.has(id)) this.send({ type: 'end', id }); });
    socket.once('error', () => this.closeChannel(id));
    socket.once('close', () => {
      entry.socketClosed = true;
      if (!entry.localEnded || !entry.remoteEnded) this.closeChannel(id);
      else this.finish(id, entry);
    });
    return true;
  }
  private finish(id: number, entry: SocketChannel): void {
    // Graceful EOF can arrive before the final acknowledgements. Retain the
    // channel until both directions have drained instead of truncating replies.
    if (entry.socketClosed && entry.sent === 0 && entry.receiving === 0) this.closeChannel(id);
  }
  private closeChannel(id: number, notify = true): void {
    const entry = this.channels.get(id); if (!entry) return;
    this.channels.delete(id); clearTimeout(entry.timer); entry.socket.destroy();
    if (!entry.opened) entry.onOpen?.(false);
    if (notify) this.send({ type: 'close', id });
  }
  dispose(): void {
    this.wire.removeListener('message', this.receive); this.wire.removeListener('closed', this.closed); this.wire.removeListener('drain', this.drained);
    for (const id of this.channels.keys()) this.closeChannel(id, false);
  }
}
