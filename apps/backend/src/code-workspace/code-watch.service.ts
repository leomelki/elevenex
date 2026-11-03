import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { watch, type FSWatcher } from 'node:fs';
import { relative, sep } from 'node:path';
import type { CodeWorkspace } from './code-authorization.service.js';
import { CodeSearch } from './code-search.service.js';

interface DirectoryWatch { watcher: FSWatcher; at: number }
interface WorkspaceWatch { directories: Map<string, DirectoryWatch>; sequence: number; events: { sequence: number; path: string }[]; at: number }
/** Observe only directories actually browsed, never every descendant. Polls reconcile open files. */
@Injectable()
export class CodeWatch implements OnModuleDestroy {
  private readonly workspaces = new Map<string, WorkspaceWatch>();
  private readonly timer = setInterval(() => this.expire(), 10_000).unref();
  constructor(private readonly search: CodeSearch) {}
  observe(workspace: CodeWorkspace, directory: string): void {
    let state = this.workspaces.get(workspace.identity);
    if (!state) {
      if (this.workspaces.size >= 8) this.release(this.workspaces.keys().next().value!);
      state = { directories: new Map(), sequence: 0, events: [], at: Date.now() };
      this.workspaces.set(workspace.identity, state);
    }
    state.at = Date.now();
    const existing = state.directories.get(directory);
    if (existing) { existing.at = Date.now(); return; }
    if (state.directories.size >= 64) {
      const oldest = [...state.directories].sort((a, b) => a[1].at - b[1].at)[0]!;
      oldest[1].watcher.close(); state.directories.delete(oldest[0]);
    }
    const current = state;
    try {
      const watcher = watch(directory, { persistent: false }, event => {
        if (this.workspaces.get(workspace.identity) !== current) return;
        if (event === 'rename' && current.directories.get(directory)?.watcher === watcher) { watcher.close(); current.directories.delete(directory); }
        this.search.invalidate(workspace.identity);
        const path = '/' + relative(workspace.root, directory).split(sep).join('/');
        this.record(current, path);
      });
      watcher.on('error', () => { watcher.close(); if (current.directories.get(directory)?.watcher === watcher) current.directories.delete(directory); this.record(current, '/'); });
      state.directories.set(directory, { watcher, at: Date.now() });
    } catch { this.record(state, '/'); }
  }
  changes(workspace: CodeWorkspace, after: number) {
    this.observe(workspace, workspace.root);
    const state = this.workspaces.get(workspace.identity)!;
    let reset = after > state.sequence || (state.events.length > 0 && after < state.events[0].sequence - 1);
    let paths = [...new Set(state.events.filter(e => e.sequence > after).map(e => e.path))].slice(0, 128);
    if (Buffer.byteLength(JSON.stringify(paths)) > 192 * 1024) { paths = ['/']; reset = true; }
    return { sequence: state.sequence, reset, paths };
  }
  onModuleDestroy(): void { clearInterval(this.timer); for (const id of this.workspaces.keys()) this.release(id); }
  release(id: string) { for (const item of this.workspaces.get(id)?.directories.values() ?? []) item.watcher.close(); this.workspaces.delete(id); }
  private record(state: WorkspaceWatch, path: string): void { state.events.push({ sequence: ++state.sequence, path }); if (state.events.length > 256) state.events.shift(); }
  private expire() { for (const [id, state] of this.workspaces) if (Date.now() - state.at > 120_000) this.release(id); }
}
