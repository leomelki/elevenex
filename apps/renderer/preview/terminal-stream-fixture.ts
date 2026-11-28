import { Injectable, signal } from '@angular/core';
import type { TaskTerminal, TaskTerminalAttach, TaskTerminalAttachment, TaskTerminalStreamEvent, TaskTerminalStreamPacket, TaskTerminalStreamWrite } from '@elevenex/shared';

const accepted = { ok: true as const, value: { accepted: true as const } };

/** Isolated stream transport for the production component's lifetime regression. */
@Injectable()
export class TerminalStreamFixture {
  readonly state = signal({ revision: 1, scope: { id: 'terminal-preview' } });
  readonly counts = { create: 0, attach: 0, detach: 0, writes: 0, resizes: 0 };
  private readonly listeners = new Set<(event: TaskTerminalStreamEvent) => void>();
  private target?: TaskTerminalAttach;
  private delivery = 0;
  private created = false;
  private terminal: TaskTerminal = { id: 1, taskId: 1, title: 'bash', cwd: '/workspace', branch: 'terminal-fix',
    generation: 'preview-generation', sequence: 0, alive: true, status: 'idle', command: '', exitCode: null, port: null, canRerun: false };
  private list() { return { taskId: 1, terminals: this.created ? [this.terminal] : [], scripts: [], limit: 16 as const, streamVersion: 1 as const, shellIntegrationControl: true as const }; }
  taskTerminalList = async () => ({ ok: true as const, value: this.list() });
  taskTerminalCreate = async () => { this.created = true; this.counts.create++; return { ok: true as const, value: this.terminal }; };
  taskTerminalPreferences = async () => ({ ok: true as const, value: { profile: null, prediction: 'off' } });
  taskTerminalAttach = async (_scope: string, target: TaskTerminalAttach) => {
    if (_scope !== this.state().scope.id) throw new Error('Stale preview scope');
    this.target = target; this.delivery = 0; this.counts.attach++;
    this.emit({ type: 'metadata', list: this.list() });
    this.emit({ type: 'control', writable: true });
    this.emit({ type: 'snapshot', delivery: ++this.delivery, terminal: this.terminal, sequence: this.terminal.sequence,
      size: { cols: 80, rows: 24 }, data: 'READY> ', first: true, last: true });
    return accepted;
  };
  taskTerminalDetach = async (_scope: string, target: TaskTerminalAttachment) => {
    if (_scope !== this.state().scope.id) return;
    this.counts.detach++;
    if (this.target?.attachmentId === target.attachmentId) this.target = undefined;
  };
  taskTerminalStreamWrite = async (_scope: string, input: TaskTerminalStreamWrite) => {
    if (_scope !== this.state().scope.id) throw new Error('Stale preview scope');
    this.counts.writes++;
    this.emit({ type: 'input-ack', sequence: input.sequence });
    if (input.data === '\x03' && this.terminal.status === 'serving') {
      this.terminal = { ...this.terminal, status: 'idle', port: null, command: '' };
      this.output('\r\n^C\r\nREADY> ');
      this.emit({ type: 'metadata', list: this.list() });
      return accepted;
    }
    this.output(input.data);
    return accepted;
  };
  taskTerminalStreamAcknowledge = async () => {};
  taskTerminalStreamFocus = async () => accepted;
  taskTerminalStreamResize = async () => { this.counts.resizes++; return accepted; };
  onTaskTerminalStream = (listener: (event: TaskTerminalStreamEvent) => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  update(index: number): void {
    this.terminal = { ...this.terminal, activityTitle: index % 2 ? 'node' : null,
      currentCwd: `/workspace/folder-${index}`, status: index % 2 ? 'running' : 'idle' };
    this.emit({ type: 'metadata', list: this.list() });
    this.output(`\r\nmetadata update ${index}\r\nREADY> `);
  }
  serve(port = 8080): void {
    this.terminal = { ...this.terminal, status: 'serving', port, command: 'pnpm dev', activityTitle: 'web' };
    this.output(`\r\nServer ready on http://localhost:${port}/\r\n`);
    this.emit({ type: 'metadata', list: this.list() });
  }
  interrupt(uncertain = false): void { this.emit({ type: 'closed', uncertain, message: 'Preview transport interrupted.' }); }
  exit(code: number): void {
    this.terminal = { ...this.terminal, alive: false, status: code ? 'failed' : 'exited', exitCode: code,
      command: 'pnpm run fail', canRerun: true };
    this.output(`\r\nCommand exited with code ${code}.\r\n`);
    this.emit({ type: 'metadata', list: this.list() });
  }
  private output(data: string): void {
    const from = this.terminal.sequence;
    this.terminal = { ...this.terminal, sequence: from + data.length };
    this.emit({ type: 'output', delivery: ++this.delivery, output: {
      terminal: this.terminal, generation: this.terminal.generation, from, next: this.terminal.sequence, data, gap: false, more: false,
    } });
  }
  private emit(packet: TaskTerminalStreamPacket): void {
    if (this.target) for (const listener of this.listeners) listener({ ...this.target, scopeId: 'terminal-preview', packet });
  }
}
