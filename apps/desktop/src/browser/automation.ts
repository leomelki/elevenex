import type { BrowserAgentCommand, BrowserAgentState, BrowserCodeCommand } from '@elevenex/shared';
import { browserCodeCommand } from '@elevenex/browser-agent';
import { randomUUID } from 'node:crypto';
import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { agentCommand, browserId, exact, record, taskId } from './validation';
import type { DesktopBrowserHost as TaskBrowser } from './host';

interface Receipt { readonly id: string; readonly value?: unknown; readonly failed?: boolean }

/** Main-owned mailbox loop. Never repeats delivered actions, even after an unknown receipt outcome. */
export class BrowserAutomation {
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly desktopId = randomUUID();
  private token = randomUUID();
  private current: TaskBrowser | null = null;
  private cancelAction?: () => void;
  private readonly codeActions = new Map<string, AbortController>();
  private supportsCode = true;
  private codeVersion: 1 | 2 = 2;
  private receipts: Receipt[] = [];
  constructor(private readonly windowId: number, private readonly client: BackendClient) {}
  select(task: TaskBrowser): void {
    if (this.current === task) return;
    if (this.current) { this.cancelActions(); this.current.suspend(); this.client.cancel(this.windowId, this.current.scopeId, 'task-browser-poll'); }
    this.current = task; this.token = randomUUID(); this.receipts = []; this.supportsCode = true; this.codeVersion = 2;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 0);
  }
  deactivate(task: TaskBrowser): void {
    if (this.current !== task) return;
    this.cancelActions(); task.suspend(); this.client.cancel(this.windowId, task.scopeId, 'task-browser-poll');
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.current = null; this.receipts = []; this.token = randomUUID();
  }
  private async poll(): Promise<void> {
    const task = this.current, token = this.token;
    if (this.disposed || !task) return;
    if (this.client.state(this.windowId).scope?.id !== task.scopeId) { this.cancelActions(); task.revoke(); this.current = null; return; }
    const receipt = this.receipts.shift();
    const result = await this.client.execute(this.windowId, task.scopeId, 'task-browser-poll:' + task.taskId + ':' + token, false,
      (endpoint, signal) => requestBackendJson(endpoint, { path: '/api/desktop-browser/poll', method: 'POST',
        body: { taskId: task.taskId, desktopId: this.desktopId, token, ...(this.supportsCode ? { codeVersion: this.codeVersion, ...(this.codeVersion === 2 ? { requests: task.humanResults?.() ?? [] } : {}), ...(this.codeActions.size ? { busy: [...this.codeActions.keys()] } : {}) } : {}), ...(receipt ? { receipt } : {}) }, limit: 262144 }, signal), this.supportsCode ? 5000 : 2000);
    if (this.disposed || this.current !== task || this.token !== token) return;
    if (!result.ok) {
      if (this.supportsCode && result.error.code === 'http' && result.error.status === 400) {
        // A rejected capability field has not delivered an action. Older hosts
        // keep their original mailbox contract and legacy automation behavior.
        if (this.codeVersion === 2) this.codeVersion = 1; else this.supportsCode = false;
        this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 0); return;
      }
      if (result.error.code === 'http' && (result.error.status === 400 || result.error.status === 404)) { this.deactivate(task); task.destroy(); return; }
      this.cancelActions(); task.revoke(); this.token = randomUUID();
    } else {
      try {
        const raw = record(result.value); exact(raw, ['command', 'ports', 'running']);
        if (raw['running'] === undefined) this.supportsCode = false;
        if (Array.isArray(raw['running'])) {
          if (raw['running'].length > 16 || raw['running'].some(id => typeof id !== 'string')) throw new Error('Invalid running browser actions');
          for (const [id, controller] of this.codeActions) if (!raw['running'].includes(id)) { controller.abort(); this.codeActions.delete(id); }
        }
        const ports = raw['ports'];
        if (!Array.isArray(ports) || ports.length > 32 || ports.some(port => typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid task ports');
        task.setPorts(ports);
        if (raw['command'] !== null) {
          const message = record(raw['command']); exact(message, ['id', 'sessionId', 'input']);
          const id = browserId(message['id']);
          try {
            const input = record(message['input']);
            if (input['kind'] === 'code') this.startCode(task, browserCodeCommand(input), taskId(message['sessionId']), id, token);
            else {
              const value = await this.execute(task, agentCommand(input), taskId(message['sessionId']));
              if (this.current === task && this.token === token) this.receipts.push({ id, value });
            }
          } catch { if (this.current === task && this.token === token) this.receipts.push({ id, failed: true }); }
        }
      } catch { this.cancelActions(); task.revoke(); this.token = randomUUID(); }
    }
    if (!this.disposed && this.current) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, this.codeActions.size ? 150 : this.supportsCode ? 0 : 400);
  }
  private startCode(task: TaskBrowser, input: BrowserCodeCommand, session: number, id: string, token: string): void {
    if (this.codeActions.size >= 8 || this.codeActions.has(id)) throw new Error('Desktop browser code capacity reached');
    const controller = new AbortController();
    this.codeActions.set(id, controller);
    void task.code(session, input, controller.signal).then(
      value => { if (this.current === task && this.token === token) this.receipts.push({ id, value }); },
      () => { if (this.current === task && this.token === token) this.receipts.push({ id, failed: true }); },
    ).finally(() => {
      if (this.codeActions.get(id) === controller) this.codeActions.delete(id);
    });
  }
  private cancelActions(): void {
    this.cancelAction?.();
    for (const controller of this.codeActions.values()) controller.abort();
    this.codeActions.clear();
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
    this.disposed = true; this.cancelActions(); if (this.timer) clearTimeout(this.timer);
    if (this.current) this.client.cancel(this.windowId, this.current.scopeId, 'task-browser-poll');
    this.current = null; this.receipts = [];
  }
}
