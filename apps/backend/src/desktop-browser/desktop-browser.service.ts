import { browserReply } from './browser-reply.js';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

interface Pending {
  readonly id: string; readonly sessionId: number; readonly command: Record<string, unknown>;
  delivered: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
interface Lease { readonly taskId: number; readonly desktopId: string; readonly token: string; seen: number; readonly pending: Map<string, Pending> }

/** Bounded at-most-once mailbox. Desktop owns browser control; backend never fabricates handoff. */
@Injectable()
export class DesktopBrowserService implements OnModuleDestroy {
  private readonly leases = new Map<string, Lease>();
  private readonly timer = setInterval(() => this.expire(), 1000);
  constructor() { this.timer.unref(); }
  poll(taskId: number, desktopId: string, token: string, receipt?: { id: string; value?: unknown; failed?: boolean }) {
    this.expire();
    let lease = this.leases.get(desktopId);
    if (lease && (lease.token !== token || lease.taskId !== taskId)) { this.drop(lease); lease = undefined; }
    if (!lease) {
      if (this.leases.size >= 64) throw new Error('Desktop browser connection limit reached');
      lease = { taskId, desktopId, token, seen: Date.now(), pending: new Map() }; this.leases.set(desktopId, lease);
    }
    lease.seen = Date.now();
    if (receipt) {
      const pending = lease.pending.get(receipt.id);
      if (pending?.delivered) { pending.cleanup(); if (receipt.failed) pending.reject(new Error('Browser action stopped. Inspect browser state before retrying.')); else { try { pending.resolve(browserReply(receipt.value)); } catch { pending.reject(new Error('Unsafe or incompatible desktop browser reply was withheld.')); } } }
    }
    const next = [...lease.pending.values()].find(item => !item.delivered);
    if (!next) return { command: null };
    next.delivered = true;
    return { command: { id: next.id, sessionId: next.sessionId, input: next.command } };
  }
  async request(taskId: number, sessionId: number, command: Record<string, unknown>, signal: AbortSignal, desktopId?: string): Promise<unknown> {
    this.expire(); signal.throwIfAborted();
    const matches = [...this.leases.values()].filter(item => item.taskId === taskId && (!desktopId || item.desktopId === desktopId));
    if (matches.length !== 1) throw new Error(matches.length ? 'Several task browsers are connected. Supply desktopId.' : 'Open this task’s Browser in the desktop. No task browser is connected.');
    const lease = matches[0]!;
    if (lease.pending.size >= 16) throw new Error('Browser command limit reached');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = () => { entry.cleanup(); reject(new Error('Browser action cancelled or outcome unknown. Inspect state; never replay input automatically.')); };
      const timer = setTimeout(fail, 15000);
      const entry: Pending = { id, sessionId, command, delivered: false, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', fail); lease.pending.delete(id); } };
      lease.pending.set(id, entry); signal.addEventListener('abort', fail, { once: true });
    });
  }
  desktops(taskId: number) { this.expire(); return [...this.leases.values()].filter(lease => lease.taskId === taskId).map(lease => ({ desktopId: lease.desktopId })); }
  private expire(): void { for (const lease of this.leases.values()) if (Date.now() - lease.seen > 3000) this.drop(lease); }
  private drop(lease: Lease): void {
    this.leases.delete(lease.desktopId);
    for (const pending of [...lease.pending.values()]) { pending.cleanup(); pending.reject(new Error('Task browser disconnected. Control was revoked; reconcile before retrying.')); }
  }
  onModuleDestroy(): void { clearInterval(this.timer); for (const lease of [...this.leases.values()]) this.drop(lease); }
}
