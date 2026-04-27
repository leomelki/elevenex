import { Injectable, inject, signal, computed } from '@angular/core';
import { UserTerminalApiService, UserTerminal } from '@/shared/services/user-terminal-api.service';
import { firstValueFrom } from 'rxjs';

interface WorktreeTerminalState {
  terminals: UserTerminal[];
  activeTerminalId: number | null;
}

const STORAGE_KEY = 'elevenex-user-terminal-state';

@Injectable({ providedIn: 'root' })
export class UserTerminalStateService {
  private api = inject(UserTerminalApiService);

  private _state = signal<Map<string, WorktreeTerminalState>>(new Map());
  private _panelOpen = signal<Map<string, boolean>>(this.loadPanelState());

  getTerminals(worktreePath: string): UserTerminal[] {
    return this._state().get(worktreePath)?.terminals ?? [];
  }

  getActiveTerminalId(worktreePath: string): number | null {
    return this._state().get(worktreePath)?.activeTerminalId ?? null;
  }

  isPanelOpen(worktreePath: string): boolean {
    return this._panelOpen().get(worktreePath) ?? false;
  }

  togglePanel(worktreePath: string): void {
    const current = this.isPanelOpen(worktreePath);
    this.setPanelOpen(worktreePath, !current);
  }

  setPanelOpen(worktreePath: string, open: boolean): void {
    const map = new Map(this._panelOpen());
    map.set(worktreePath, open);
    this._panelOpen.set(map);
    this.savePanelState(map);
  }

  setActiveTerminal(worktreePath: string, terminalId: number | null): void {
    const map = new Map(this._state());
    const existing = map.get(worktreePath) ?? { terminals: [], activeTerminalId: null };
    map.set(worktreePath, { ...existing, activeTerminalId: terminalId });
    this._state.set(map);
  }

  async loadTerminals(worktreePath: string): Promise<UserTerminal[]> {
    const terminals = await firstValueFrom(this.api.listByWorktree(worktreePath));
    const map = new Map(this._state());
    const existing = map.get(worktreePath);
    const activeTerminalId = existing?.activeTerminalId
      ?? (terminals.length > 0 ? terminals[0].id : null);
    map.set(worktreePath, { terminals, activeTerminalId });
    this._state.set(map);
    return terminals;
  }

  addTerminal(worktreePath: string, terminal: UserTerminal): void {
    const map = new Map(this._state());
    const existing = map.get(worktreePath) ?? { terminals: [], activeTerminalId: null };
    map.set(worktreePath, {
      terminals: [...existing.terminals, terminal],
      activeTerminalId: terminal.id,
    });
    this._state.set(map);
  }

  removeTerminal(worktreePath: string, terminalId: number): void {
    const map = new Map(this._state());
    const existing = map.get(worktreePath);
    if (!existing) return;

    const terminals = existing.terminals.filter(t => t.id !== terminalId);
    let activeTerminalId = existing.activeTerminalId;

    // If the removed terminal was active, select the last remaining one
    if (activeTerminalId === terminalId) {
      activeTerminalId = terminals.length > 0 ? terminals[terminals.length - 1].id : null;
    }

    map.set(worktreePath, { terminals, activeTerminalId });
    this._state.set(map);
  }

  updateTerminalName(worktreePath: string, terminalId: number, name: string): void {
    const map = new Map(this._state());
    const existing = map.get(worktreePath);
    if (!existing) return;

    const terminals = existing.terminals.map(t =>
      t.id === terminalId ? { ...t, name } : t
    );
    map.set(worktreePath, { ...existing, terminals });
    this._state.set(map);
  }

  private loadPanelState(): Map<string, boolean> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return new Map(Object.entries(data.panelOpen ?? {}));
      }
    } catch {
      // Ignore
    }
    return new Map();
  }

  private savePanelState(map: Map<string, boolean>): void {
    try {
      const data = { panelOpen: Object.fromEntries(map) };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore
    }
  }
}
