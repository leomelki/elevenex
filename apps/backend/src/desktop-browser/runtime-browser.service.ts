import { RuntimeBrowserPersistence } from './runtime-persistence.js';
import {
  Injectable,
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
/** One authoritative viewer lease per runtime task. New connections revoke old driver generations. */
@Injectable()
export class RuntimeBrowserService implements OnModuleDestroy {
  private readonly tasks = new Map<number, RuntimeBrowserTask>();
  private readonly identities = new Map<number, string>();
  private readonly saved = new Map<number, string>();
  private readonly viewers = new Map<number, Viewer>();
  private readonly timer = setInterval(() => this.sweep(), 1000);
  constructor(
    private readonly pool: RuntimeBrowserPool,
    private readonly persistence: RuntimeBrowserPersistence,
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
    const old = this.viewers.get(taskId);
    if (old && old.clientId !== clientId && Date.now() - old.seen < 10000)
      throw new ConflictException({
        code: 'browser-viewer-in-use',
        message: 'This task browser already has an active viewer',
      });
    task.reconcile();
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
    const key = taskId + ':' + identity;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const operation = this.prepareTask(taskId, identity).finally(() =>
      this.opening.delete(key),
    );
    this.opening.set(key, operation);
    return operation;
  }
  private async prepareTask(
    taskId: number,
    identity: string,
  ): Promise<RuntimeBrowserTask> {
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
        const evict = [...this.tasks].find(([id]) => !this.viewers.has(id));
        if (!evict) throw new Error('Remote browser task limit reached');
        const previousIdentity = this.identities.get(evict[0]);
        if (previousIdentity)
          await this.persistence.save(previousIdentity, evict[1].saved());
        await evict[1].destroy();
        this.tasks.delete(evict[0]);
        this.identities.delete(evict[0]);
        this.saved.delete(evict[0]);
      }
      task = new RuntimeBrowserTask(taskId, this.pool, identity);
      this.tasks.set(taskId, task);
      this.identities.set(taskId, identity);
      const saved = await this.persistence.read(identity);
      if (saved) task.restore(saved);
    }
    return task;
  }
  viewer(taskId: number, token: unknown): RuntimeBrowserTask {
    const viewer = this.viewers.get(taskId);
    if (
      typeof token !== 'string' ||
      token.length !== 36 ||
      !viewer ||
      Date.now() - viewer.seen > 10000 ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(viewer.token))
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
    return task?.alive && this.viewers.has(taskId) ? task : null;
  }
  disconnect(taskId: number, token: unknown): void {
    const task = this.viewer(taskId, token);
    task.reconcile();
    this.viewers.delete(taskId);
  }
  private sweep(): void {
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
      if (Date.now() - viewer.seen > 10000) {
        viewer.task.reconcile();
        this.viewers.delete(id);
      }
    for (const [id, task] of this.tasks)
      if (task.expired) {
        this.tasks.delete(id);
        this.identities.delete(id);
        this.saved.delete(id);
        void task.destroy();
      }
  }
  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
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
