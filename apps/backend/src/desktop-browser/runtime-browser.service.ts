import { SessionsService } from '../sessions/sessions.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import {
  Injectable,
  Optional,
  ForbiddenException,
  ConflictException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { RuntimeBrowserPool } from './runtime-browser-pool.js';
import { RuntimeBrowserTask } from './runtime-task.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';

interface Viewer {
  readonly task: RuntimeBrowserTask;
  readonly token: string;
  readonly clientId: string;
  seen: number;
  readonly layoutSequences: Map<string, number>;
}
/** Viewer authority rotates independently of retained task execution and agent drivers. */
@Injectable()
export class RuntimeBrowserService implements OnModuleDestroy {
  private readonly tasks = new Map<number, RuntimeBrowserTask>();
  private readonly identities = new Map<number, string>();
  private readonly saved = new Map<number, string>();
  private readonly viewers = new Map<number, Viewer>();
  private stopped = false;
  private preparing: Promise<void> = Promise.resolve();
  private readonly timer = setInterval(() => this.sweep(), 1000);
  constructor(
    private readonly pool: RuntimeBrowserPool,
    private readonly persistence: RuntimeBrowserPersistence,
    @Optional() private readonly taskRecords?: TasksService,
    @Optional() private readonly sessionRecords?: SessionsService,
  ) {
    this.timer.unref();
  }
  reservePort(port: number | undefined): void {
    this.pool.reservePort(port);
  }
  async connect(
    taskId: number,
    clientId: string,
    identity: string,
  ): Promise<{
    token: string;
    state: ReturnType<RuntimeBrowserTask['state']>;
  }> {
    const task = await this.prepare(taskId, identity);
    if (this.stopped || this.tasks.get(taskId) !== task)
      throw new Error('Browser task preparation was interrupted');
    const old = this.viewers.get(taskId);
    if (old && old.clientId !== clientId && Date.now() - old.seen < 30000)
      throw new ConflictException({
        code: 'browser-viewer-in-use',
        message: 'This task browser already has an active viewer',
      });
    // A first viewer may arrive to answer an agent's pending site request.
    // Rotating an existing viewer invalidates that viewer's old requests.
    task.reconcile(old !== undefined);
    task.touch();
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    const viewer = {
      task,
      clientId,
      token: randomUUID(),
      seen: Date.now(),
      layoutSequences: new Map<string, number>(),
    };
    this.viewers.set(taskId, viewer);
    return { token: viewer.token, state: task.state() };
  }
  private readonly opening = new Map<string, Promise<RuntimeBrowserTask>>();
  prepare(taskId: number, identity: string): Promise<RuntimeBrowserTask> {
    if (this.stopped) return Promise.reject(new Error('Browser runtime stopped'));
    const key = taskId + ':' + identity;
    const pending = this.opening.get(key);
    if (pending) return pending;
    if (this.opening.size >= 8) return Promise.reject(new Error('Browser task preparation limit reached'));
    // Task allocation includes asynchronous profile disposal and metadata reads.
    // Serialize this boundary so competing callers cannot evict the same owner
    // or publish more than four tasks. Ordinary viewer operations remain independent.
    const operation = this.preparing.then(() => this.prepareTask(taskId, identity)).finally(() =>
      this.opening.delete(key),
    );
    this.preparing = operation.then(() => undefined, () => undefined);
    this.opening.set(key, operation);
    return operation;
  }
  private async prepareTask(
    taskId: number,
    identity: string,
  ): Promise<RuntimeBrowserTask> {
    if (this.stopped) throw new Error('Browser runtime stopped');
    let task = this.tasks.get(taskId);
    if (task && this.identities.get(taskId) !== identity) {
      this.viewers.delete(taskId);
      await task.destroy();
      this.tasks.delete(taskId);
      this.saved.delete(taskId);
      task = undefined;
    }
    if (!task) {
      if (this.tasks.size >= 4) {
        const evict = [...this.tasks].find(([id, owner]) => !this.viewers.has(id) && !owner.retained);
        if (!evict) throw new Error('Remote browser task limit reached');
        const previousIdentity = this.identities.get(evict[0]);
        if (previousIdentity)
          await this.persistence.save(previousIdentity, evict[1].saved());
        await evict[1].destroy();
        this.tasks.delete(evict[0]);
        this.identities.delete(evict[0]);
        this.saved.delete(evict[0]);
      }
      if (this.stopped) throw new Error('Browser runtime stopped');
      const saved = await this.persistence.read(identity);
      if (this.stopped) throw new Error('Browser runtime stopped');
      task = new RuntimeBrowserTask(taskId, this.pool, identity, async sessionId => {
        const session = await this.sessionRecords?.findOne(sessionId);
        if (!session || session.workspaceId !== taskId || session.status === 'archived') throw new Error('Requesting conversation is unavailable');
      });
      if (saved) task.restore(saved);
      this.tasks.set(taskId, task);
      this.identities.set(taskId, identity);
    }
    return task;
  }
  viewer(taskId: number, token: unknown): RuntimeBrowserTask {
    const viewer = this.viewers.get(taskId);
    const bytes = typeof token === 'string' ? Buffer.from(token) : null;
    if (
      this.stopped ||
      !bytes ||
      bytes.length !== 36 ||
      !viewer ||
      Date.now() - viewer.seen > 30000 ||
      !timingSafeEqual(bytes, Buffer.from(viewer.token))
    )
      throw new ForbiddenException('Browser viewer lease expired');
    viewer.seen = Date.now();
    viewer.task.touch();
    return viewer.task;
  }
  layoutViewer(
    taskId: number,
    token: string,
    sequence: number,
    tabId?: string,
  ): RuntimeBrowserTask | null {
    const task = this.viewer(taskId, token);
    const viewer = this.viewers.get(taskId)!;
    // Panel and companion layouts are independent lanes. A late update for one
    // display must not suppress another display's visibility or viewport.
    const key = tabId ?? 'panel';
    if (tabId && !task.tabs.has(tabId)) throw new ForbiddenException('Browser tab closed');
    if (sequence <= (viewer.layoutSequences.get(key) ?? -1)) return null;
    for (const id of viewer.layoutSequences.keys()) if (id !== 'panel' && !task.tabs.has(id)) viewer.layoutSequences.delete(id);
    viewer.layoutSequences.set(key, sequence);
    return task;
  }
  active(taskId: number): RuntimeBrowserTask | null {
    const task = this.tasks.get(taskId);
    return !this.stopped && task?.alive ? task : null;
  }
  disconnect(taskId: number, token: unknown): void {
    const task = this.viewer(taskId, token);
    task.reconcile();
    this.viewers.delete(taskId);
  }
  private checking?: Promise<void>;
  private async checkTasks(): Promise<void> {
    if (!this.taskRecords || this.stopped) return;
    try {
      for (const [id, task] of this.tasks) {
        const record = await this.taskRecords.record(id).catch(() => null);
        if (this.tasks.get(id) !== task || this.stopped) continue;
        if (record && !record.archivedAt && record.taskState === 'ready') continue;
        // A retained browser must not outlive task finish/archive or keep its
        // workspace connections open. Never evict a live task for viewer idleness.
        const retirement = this.preparing.then(async () => {
          if (this.tasks.get(id) !== task || this.stopped) return;
          const identity = this.identities.get(id);
          if (identity) await this.persistence.save(identity, task.saved());
          await task.destroy();
          this.tasks.delete(id);
          this.viewers.delete(id);
          this.identities.delete(id);
          this.saved.delete(id);
        });
        this.preparing = retirement.catch(() => undefined);
        await retirement;
      }
    } catch { /* Retry bounded lifecycle reconciliation on the next sweep. */ }
  }
  private sweep(): void {
    this.checking ??= this.checkTasks().finally(() => { this.checking = undefined; });
    for (const [id, task] of this.tasks) {
      task.sweep();
      const saved = task.saved(),
        signature = JSON.stringify(saved);
      if (this.saved.get(id) !== signature) {
        this.saved.set(id, signature);
        const identity = this.identities.get(id);
        if (identity) void this.persistence.save(identity, saved);
      }
    }
    for (const [id, viewer] of this.viewers)
      if (Date.now() - viewer.seen > 30000) {
        viewer.task.reconcile();
        this.viewers.delete(id);
      }

  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.preparing;
    await this.checking;
    for (const [id, task] of this.tasks) {
      const identity = this.identities.get(id);
      if (identity) await this.persistence.save(identity, task.saved());
    }
    this.viewers.clear();
    await Promise.allSettled(
      [...this.tasks.values()].map((task) => task.destroy()),
    );
    this.tasks.clear();
    await this.persistence.flush();
  }
}
