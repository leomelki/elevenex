import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import type { CodeOpenFile, CodeSurfaceState, CodeTarget } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
/** Task selection and UI status only; privileged runtime ownership lives in main. */
@Injectable()
export class CodeWorkspaceStore {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private epoch = 0;
  private selected: CodeTarget | null = null;
  private opening?: Promise<void>;
  private destroyed = false;
  readonly state = signal<CodeSurfaceState | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  constructor() {
    const stop = this.bridge.onCodeChanged?.(event => {
      if (!this.destroyed && this.selected?.scopeId === event.target.scopeId && this.selected.taskId === event.target.taskId) this.state.set(event.state);
    });
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; stop?.(); this.select(null); });
  }
  select(target: CodeTarget | null): void {
    if (this.selected?.scopeId === target?.scopeId && this.selected?.taskId === target?.taskId) return;
    const previous = this.selected; this.epoch++; this.selected = target; this.opening = undefined;
    this.state.set(null); this.error.set(''); this.busy.set(false);
    if (previous) void this.bridge.codeRelease?.(previous).catch(() => undefined);
  }
  open(): Promise<void> {
    if (this.opening) return this.opening;
    const target = this.selected, epoch = this.epoch;
    if (!target || this.destroyed) return Promise.resolve();
    if (typeof this.bridge.codeOpen !== 'function') { this.error.set('Open this workspace in the desktop app to use Code.'); return Promise.resolve(); }
    this.busy.set(true); this.error.set('');
    const pending = (async () => {
      try {
        const reply = await this.bridge.codeOpen(target);
        if (this.destroyed || epoch !== this.epoch) return;
        if (reply.ok) this.state.set(reply.value); else this.error.set(reply.error.message);
      } catch { if (epoch === this.epoch && !this.destroyed) this.error.set('Code could not open. Try again when the machine is connected.'); }
      finally { if (epoch === this.epoch) { this.busy.set(false); this.opening = undefined; } }
    })();
    this.opening = pending; return pending;
  }
  adopt(state: CodeSurfaceState): void { if (!this.state() && state.taskId === this.selected?.taskId) this.state.set(state); }
  suspend(): void {
    this.epoch++; this.opening = undefined; this.busy.set(false);
    if (this.selected) void this.bridge.codeRelease?.(this.selected).catch(() => undefined);
  }
  async detach(): Promise<void> { const epoch = this.epoch; await this.open(); if (epoch !== this.epoch || this.destroyed || this.error()) return; try { if (this.selected && this.state()) await this.bridge.codeDetach(this.selected); } catch { if (epoch === this.epoch) this.error.set('The editor window could not open. Your current editor is retained.'); } }
  async openFile(file: CodeOpenFile): Promise<void> {
    const target = this.selected, epoch = this.epoch;
    await this.open();
    if (!target || epoch !== this.epoch || this.destroyed || !this.state()) return;
    let result; try { result = await this.bridge.codeOpenFile(target, file); } catch { result = { ok: false as const, error: { message: 'This path could not be opened in the current task.' } }; }
    if (!result.ok && epoch === this.epoch) this.error.set(result.error.message);
  }
  async recover(): Promise<void> {
    const target = this.selected, epoch = this.epoch; if (!target || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try { const result = await this.bridge.codeRecover(target); if (epoch !== this.epoch) return; if (result.ok) { this.error.set(''); this.state.set(result.value); } else this.error.set(result.error.message); }
    catch { if (epoch === this.epoch && !this.destroyed) this.error.set('Code could not reconnect. Your editor is retained. Try again when the machine is connected.'); }
    finally { if (epoch === this.epoch) this.busy.set(false); }
  }
  focus(): void { const epoch = this.epoch; if (this.selected) void this.bridge.codeFocus(this.selected).catch(() => { if (epoch === this.epoch && !this.destroyed) this.error.set('The editor is unavailable. Reopen Code to recover it.'); }); }
}
