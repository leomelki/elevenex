import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { ScreenCommand, ScreenResponse, ScreenSnapshot } from './terminal-screen-protocol.js';

interface ScreenOwner {
  incarnation: number;
  pending: number;
  paused: boolean;
  pause(): void;
  resume(): void;
  reply(data: string): void;
}
/** Manager-owned isolated screen model. Credits include messages waiting in the
 * worker queue, not just xterm's internal queue. Failure resumes every producer. */
export class TerminalScreenHost {
  private worker?: Worker;
  private failed = false;
  private request = 0;
  private incarnation = 0;
  private readonly owners = new Map<number, ScreenOwner>();
  private readonly requests = new Map<number, { id: number; resolve(value: ScreenSnapshot | string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly workerFile = __filename.endsWith('.ts')
    ? join(__dirname, '../../../dist/user-terminal/screen/terminal-screen-worker.js')
    : join(__dirname, __filename.endsWith('.cjs') ? 'terminal-screen-worker.cjs' : 'terminal-screen-worker.js'),
    private readonly unavailable: () => void = () => {}) {}

  open(id: number, cols: number, rows: number, owner: Omit<ScreenOwner, 'pending' | 'paused' | 'incarnation'>): void {
    if (this.failed) return;
    if (!this.worker) {
      try { this.worker = new Worker(this.workerFile); }
      catch { this.fail(); return; }
      this.worker.on('message', (message: ScreenResponse) => this.receive(message));
      this.worker.on('error', () => this.fail());
      this.worker.on('exit', () => this.fail());
      this.worker.unref();
    }
    this.owners.set(id, { ...owner, pending: 0, paused: false, incarnation: ++this.incarnation });
    this.send({ type: 'open', id, cols, rows });
  }
  get available(): boolean { return !!this.worker && !this.failed; }
  get supported(): boolean { return !this.failed; }
  write(id: number, data: string, next: number): void {
    const owner = this.owners.get(id);
    if (!owner || this.failed) return;
    owner.pending += data.length;
    if (owner.pending > 256 * 1024 && !owner.paused) { owner.paused = true; owner.pause(); }
    this.send({ type: 'write', id, data, next });
  }
  resize(id: number, cols: number, rows: number): void { this.send({ type: 'resize', id, cols, rows }); }
  async snapshot(id: number): Promise<ScreenSnapshot> {
    const value = await this.read(id, 'snapshot');
    if (typeof value === 'string') throw new Error('Invalid terminal screen');
    return value;
  }
  async context(id: number): Promise<string> {
    const value = await this.read(id, 'context');
    if (typeof value !== 'string') throw new Error('Invalid terminal context');
    return value;
  }
  close(id: number): void {
    const owner = this.owners.get(id);
    if (owner?.paused) owner.resume();
    this.send({ type: 'close', id }); this.owners.delete(id);
    for (const [request, pending] of this.requests) if (pending.id === id) {
      clearTimeout(pending.timer); this.requests.delete(request); pending.reject(new Error('Terminal process changed'));
    }
  }
  dispose(): void { this.fail(); void this.worker?.terminate(); this.worker = undefined; }
  private send(value: ScreenCommand): void {
    const owner = this.owners.get(value.id);
    if (!this.failed && owner) this.worker?.postMessage({ ...value, incarnation: owner.incarnation });
  }
  private read(id: number, type: 'snapshot' | 'context'): Promise<ScreenSnapshot | string> {
    if (!this.available || !this.owners.has(id) || this.requests.size >= 32)
      return Promise.reject(new Error('Terminal screen is unavailable'));
    const request = ++this.request;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(request); reject(new Error('Terminal screen timed out')); }, 10000);
      this.requests.set(request, { id, resolve, reject, timer });
      this.send({ type, id, request });
    });
  }
  private receive(message: ScreenResponse): void {
    if (message.type === 'consumed') {
      const owner = this.owners.get(message.id);
      if (!owner || owner.incarnation !== message.incarnation) return;
      owner.pending = Math.max(0, owner.pending - message.length);
      if (owner.paused && owner.pending < 64 * 1024) { owner.paused = false; owner.resume(); }
    } else if (message.type === 'reply') {
      const owner = this.owners.get(message.id);
      if (owner?.incarnation === message.incarnation) owner.reply(message.data);
    }
    else {
      const pending = this.requests.get(message.request);
      if (!pending) return;
      this.requests.delete(message.request); clearTimeout(pending.timer);
      if (message.type === 'failure') pending.reject(new Error(message.message));
      else pending.resolve(message.value);
    }
  }
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    for (const owner of this.owners.values()) if (owner.paused) owner.resume();
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('Terminal screen worker stopped')); }
    this.requests.clear(); this.owners.clear();
    this.unavailable();
  }
}
