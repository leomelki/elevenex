import { BrowserHumanMailbox } from './browser-human-mailbox.js';
import type { BrowserHumanRequest, BrowserCodeResult } from '@elevenex/shared';
import { browserCodeCommand, browserCodeResult } from '@elevenex/browser-agent';
import type { BrowserCodeCommand } from '@elevenex/shared';
import { TasksService } from '../tasks/tasks.service.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import type { BrowserAgentCommand } from '@elevenex/shared';
import { browserReply } from './browser-reply.js';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

interface Pending {
  readonly id: string;
  readonly sessionId: number;
  readonly command: Record<string, unknown>;
  delivered: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
interface Lease {
  readonly taskId: number;
  readonly desktopId: string;
  readonly token: string;
  seen: number;
  readonly pending: Map<string, Pending>;
  codeVersion?: 1 | 2;
}

/** Bounded desktop mailbox and task-runtime routing. Neither path fabricates user handoff. */
@Injectable()
export class DesktopBrowserService implements OnModuleDestroy {
  private readonly humanRequests = new BrowserHumanMailbox();
  private readonly leases = new Map<string, Lease>();
  private readonly waiting = new Map<string, () => void>();
  private readonly timer = setInterval(() => this.expire(), 1000);
  constructor(
    private readonly runtime?: RuntimeBrowserService,
    private readonly tasks?: TasksService,
    private readonly servers?: TaskBrowserServers,
  ) {
    this.timer.unref();
  }
  poll(
    taskId: number,
    desktopId: string,
    token: string,
    receipt?: { id: string; value?: unknown; failed?: boolean },
    codeVersion?: 1 | 2,
    busy?: readonly string[],
    humanResults?: readonly BrowserHumanRequest[],
  ) {
    this.expire();
    let lease = this.leases.get(desktopId);
    if (lease && (lease.token !== token || lease.taskId !== taskId)) {
      this.drop(lease);
      lease = undefined;
    }
    if (!lease) {
      if (this.leases.size >= 64)
        throw new Error('Desktop browser connection limit reached');
      lease = {
        taskId,
        desktopId,
        token,
        seen: Date.now(),
        pending: new Map(),
        ...(codeVersion ? { codeVersion } : {}),
      };
      this.leases.set(desktopId, lease);
    }
    lease.seen = Date.now();
    if (codeVersion) lease.codeVersion = codeVersion;
    if (receipt) {
      const pending = lease.pending.get(receipt.id);
      if (pending?.delivered) {
        pending.cleanup();
        if (receipt.failed)
          pending.reject(
            new Error(
              'Browser action stopped. Inspect browser state before retrying.',
            ),
          );
        else {
          try {
            pending.resolve(
              pending.command['kind'] === 'code'
                ? this.recordCode(lease.taskId, pending.sessionId, lease.desktopId, browserCodeResult(receipt.value))
                : browserReply(receipt.value),
            );
          } catch {
            pending.reject(
              new Error(
                'Unsafe or incompatible desktop browser reply was withheld.',
              ),
            );
          }
        }
      }
    }
    if (humanResults) this.humanRequests.update(taskId, desktopId, humanResults);
    const running = [...lease.pending.values()]
      .filter((item) => item.delivered)
      .map((item) => item.id);
    const occupied = new Set([...running, ...(busy ?? [])]);
    const next = [...lease.pending.values()].find(
      (item) =>
        !item.delivered &&
        (item.command['kind'] === 'code'
          ? occupied.size < 8
          : occupied.size === 0),
    );
    if (!next) return { command: null, ...(codeVersion ? { running } : {}) };
    next.delivered = true;
    return {
      command: { id: next.id, sessionId: next.sessionId, input: next.command },
      ...(codeVersion ? { running: [...running, next.id] } : {}),
    };
  }
  /** New desktops wait for commands instead of paying a polling interval on
   * every tool call. One cancellable waiter per lease; old clients are unchanged. */
  async wait(
    desktopId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const lease = this.leases.get(desktopId);
    if (
      !lease ||
      lease.token !== token ||
      [...lease.pending.values()].some((item) => !item.delivered)
    )
      return;
    this.waiting.get(desktopId)?.();
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        if (this.waiting.get(desktopId) === finish)
          this.waiting.delete(desktopId);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      this.waiting.set(desktopId, finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  async request(
    taskId: number,
    sessionId: number,
    command: Record<string, unknown>,
    signal: AbortSignal,
    desktopId?: string,
  ): Promise<unknown> {
    this.expire();
    signal.throwIfAborted();
    let hosted = this.runtime?.active(taskId);
    if (this.runtime && this.tasks) {
      const task = await this.tasks.record(taskId);
      if (task.archivedAt || task.taskState !== 'ready')
        throw new Error('Task is not active');
      if (
        hosted ||
        (!desktopId &&
          ![...this.leases.values()].some((lease) => lease.taskId === taskId))
      ) {
        const identity = createHash('sha256')
          .update(JSON.stringify([task.repoId, task.id, task.createdAt]))
          .digest('hex');
        hosted = await this.runtime.prepare(taskId, identity);
        hosted.setPorts((await this.servers?.ports(taskId)) ?? []);
      }
    }
    signal.throwIfAborted();
    if (hosted && (!desktopId || desktopId === hosted.id)) {
      if (
        !desktopId &&
        [...this.leases.values()].some((lease) => lease.taskId === taskId)
      )
        throw new Error(
          'Several task browsers are connected. Supply desktopId.',
        );
      return command['kind'] === 'code'
        ? this.recordCode(taskId, sessionId, hosted.id, browserCodeResult(
            await hosted.code(sessionId, browserCodeCommand(command), signal),
          ))
        : this.runtimeRequest(
            hosted,
            command as BrowserAgentCommand,
            sessionId,
            signal,
          );
    }
    const matches = [...this.leases.values()].filter(
      (item) =>
        item.taskId === taskId && (!desktopId || item.desktopId === desktopId),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? 'Several task browsers are connected. Supply desktopId.'
          : 'Open this task’s Browser in the desktop. No task browser is connected.',
      );
    const lease = matches[0];
    if (command['kind'] === 'code' && (command['api'] === 2 ? lease.codeVersion !== 2 : !lease.codeVersion))
      throw new Error(
        'This desktop needs an update for code-first browser automation',
      );
    if (command['kind'] === 'code') {
      for (const pending of lease.pending.values()) {
        if (
          pending.sessionId !== sessionId ||
          pending.command['kind'] !== 'code'
        )
          continue;
        if (!command['reset'])
          throw new Error('Browser code already running for this session');
        pending.cleanup();
        pending.reject(
          new Error(
            'Browser code reset; inspect accepted actions before repeating them',
          ),
        );
      }
    }
    if (lease.pending.size >= 16)
      throw new Error('Browser command limit reached');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = () => {
        entry.cleanup();
        reject(
          new Error(
            'Browser action cancelled or outcome unknown. Inspect state; never replay input automatically.',
          ),
        );
      };
      const timer = setTimeout(
        fail,
        command['kind'] === 'code'
          ? browserCodeCommand(command).timeoutMs + 5000
          : 15000,
      );
      const entry: Pending = {
        id,
        sessionId,
        command,
        delivered: false,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', fail);
          lease.pending.delete(id);
        },
      };
      lease.pending.set(id, entry);
      signal.addEventListener('abort', fail, { once: true });
      this.waiting.get(lease.desktopId)?.();
    });
  }
  private recordCode(taskId: number, sessionId: number, hostId: string, result: BrowserCodeResult): BrowserCodeResult {
    this.humanRequests.register(taskId, sessionId, hostId, result.requests ?? []); return result;
  }
  async waitForUser(taskId: number, sessionId: number, requestId: string, timeoutMs: number, signal: AbortSignal) {
    const entry = this.humanRequests.get(taskId, sessionId, requestId), runtime = this.runtime?.active(taskId);
    if (entry.value.status !== 'pending') return entry.value;
    let stop: (() => void) | undefined;
    if (runtime?.id === entry.hostId) {
      const refresh = () => this.humanRequests.update(taskId, runtime.id, runtime.humanResults());
      stop = runtime.subscribe(refresh); refresh();
    } else if (![...this.leases.values()].some(lease => lease.desktopId === entry.hostId && lease.taskId === taskId)) throw new Error('Open the task browser to complete this human request');
    try { return await this.humanRequests.wait(taskId, sessionId, requestId, timeoutMs, signal); } finally { stop?.(); }
  }
  requestCode(
    taskId: number,
    sessionId: number,
    command: BrowserCodeCommand,
    signal: AbortSignal,
    desktopId?: string,
  ) {
    return this.request(
      taskId,
      sessionId,
      { ...browserCodeCommand(command) },
      signal,
      desktopId,
    ).then(browserCodeResult);
  }
  desktops(taskId: number) {
    this.expire();
    const hosted = this.runtime?.active(taskId);
    return [
      ...[...this.leases.values()]
        .filter((lease) => lease.taskId === taskId)
        .map((lease) => ({
          desktopId: lease.desktopId,
          ...(lease.codeVersion ? { codeVersion: lease.codeVersion } : {}),
        })),
      ...(hosted ? [{ desktopId: hosted.id }] : []),
    ];
  }
  private async runtimeRequest(
    hosted: import('./runtime-task.js').RuntimeBrowserTask,
    input: BrowserAgentCommand,
    sessionId: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      abort,
      ['open', 'navigate', 'reload'].includes(input.kind) ? 200000 : 30000,
    );
    let stop: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error('Browser action stopped'));
      controller.signal.addEventListener('abort', stop, { once: true });
    });
    try {
      return browserReply(
        await Promise.race([
          hosted.agent(input, sessionId, controller.signal),
          cancelled,
        ]),
      );
    } catch {
      throw new Error(
        'Browser action stopped. Inspect the page before retrying.',
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
    }
  }
  private expire(): void {
    this.humanRequests.sweep();
    for (const lease of this.leases.values())
      if (Date.now() - lease.seen > (lease.codeVersion ? 10000 : 3000))
        this.drop(lease);
  }
  private drop(lease: Lease): void {
    this.humanRequests.disconnected(lease.desktopId);
    this.waiting.get(lease.desktopId)?.();
    this.leases.delete(lease.desktopId);
    for (const pending of [...lease.pending.values()]) {
      pending.cleanup();
      pending.reject(
        new Error(
          'Task browser disconnected. Control was revoked; reconcile before retrying.',
        ),
      );
    }
  }
  onModuleDestroy(): void {
    this.humanRequests.dispose();
    clearInterval(this.timer);
    for (const lease of [...this.leases.values()]) this.drop(lease);
  }
}
