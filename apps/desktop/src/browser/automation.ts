import type { BrowserAgentCommand, BrowserAgentState } from '@elevenex/shared';
import { randomUUID } from 'node:crypto';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { agentCommand, browserId, exact, record, taskId } from './validation';
import type { TaskBrowser } from './task';

/** Main-owned mailbox loop. Never repeats delivered actions, even after an unknown receipt outcome. */
export class BrowserAutomation {
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly desktopId = randomUUID();
  private token = randomUUID();
  private current: TaskBrowser | null = null;
  private cancelAction?: () => void;
  private receipt?: { id: string; value?: unknown; failed?: boolean };
  constructor(private readonly windowId: number, private readonly client: BackendClient) {}
  select(task: TaskBrowser): void {
    if (this.current === task) return;
    if (this.current) { this.cancelAction?.(); this.current.suspend(); this.client.cancel(this.windowId, this.current.scopeId, 'task-browser-poll'); }
    this.current = task; this.token = randomUUID(); this.receipt = undefined;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 0);
  }
  deactivate(task: TaskBrowser): void {
    if (this.current !== task) return;
    this.cancelAction?.(); task.suspend(); this.client.cancel(this.windowId, task.scopeId, 'task-browser-poll');
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.current = null; this.receipt = undefined; this.token = randomUUID();
  }
  private async poll(): Promise<void> {
    const task = this.current, token = this.token;
    if (this.disposed || !task) return;
    if (this.client.state(this.windowId).scope?.id !== task.scopeId) { task.revoke(); this.current = null; return; }
    const receipt = this.receipt; this.receipt = undefined;
    const result = await this.client.execute(this.windowId, task.scopeId, 'task-browser-poll:' + task.taskId + ':' + token, false,
      (endpoint, signal) => requestBackendJson(endpoint, { path: '/api/desktop-browser/poll', method: 'POST',
        body: { taskId: task.taskId, desktopId: this.desktopId, token, ...(receipt ? { receipt } : {}) }, limit: 32768 }, signal), 2000);
    if (this.disposed || this.current !== task || this.token !== token) return;
    if (!result.ok) {
      if (result.error.code === 'http' && (result.error.status === 400 || result.error.status === 404)) { this.deactivate(task); task.destroy(); return; }
      task.revoke(); this.token = randomUUID();
    } else {
      try {
        const raw = record(result.value); exact(raw, ['command', 'ports']);
        const ports = raw['ports'];
        if (!Array.isArray(ports) || ports.length > 32 || ports.some(port => typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid task ports');
        task.setPorts(ports);
        if (raw['command'] !== null) {
          const message = record(raw['command']); exact(message, ['id', 'sessionId', 'input']);
          const id = browserId(message['id']);
          try {
            const input = agentCommand(message['input']);
            const value = await this.execute(task, input, taskId(message['sessionId']));
            if (this.current === task && this.token === token) this.receipt = { id, value };
          } catch { if (this.current === task && this.token === token) this.receipt = { id, failed: true }; }
        }
      } catch { task.revoke(); this.token = randomUUID(); }
    }
    if (!this.disposed && this.current) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 400);
  }
  private execute(task: TaskBrowser, input: BrowserAgentCommand, session: number): Promise<BrowserAgentState> {
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        if (finished) return;
        finished = true; clearTimeout(deadline); controller.abort();
        reject(new Error('Browser action expired or stopped; control was revoked'));
      };
      // Shorter than the backend's three-second lease. Late DOM/forward replies
      // still check the revoked generation before any input or navigation.
      deadline = setTimeout(cancel, 2000);
    });
    this.cancelAction = cancel;
    return Promise.race([task.agent(input, session, controller.signal), cancelled]).finally(() => {
      finished = true; clearTimeout(deadline);
      if (this.cancelAction === cancel) this.cancelAction = undefined;
    });
  }
  dispose(): void {
    this.disposed = true; this.cancelAction?.(); if (this.timer) clearTimeout(this.timer);
    if (this.current) this.client.cancel(this.windowId, this.current.scopeId, 'task-browser-poll');
    this.current = null; this.receipt = undefined;
  }
}
