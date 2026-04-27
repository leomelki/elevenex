import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Action } from '@/shared/models/action.model';
import { ActionsApiService } from '@/shared/services/actions-api.service';

interface WorktreeActionState {
  actions: Action[];
  selectedActionId: number | null;
}

const STORAGE_KEY = 'elevenex-actions-state';

@Injectable({ providedIn: 'root' })
export class ActionsStateService {
  private api = inject(ActionsApiService);

  private readonly state = signal<Map<string, WorktreeActionState>>(new Map());
  private readonly panelOpen = signal<Map<string, boolean>>(this.loadPanelState());

  getActions(worktreePath: string): Action[] {
    return this.state().get(worktreePath)?.actions ?? [];
  }

  getSelectedActionId(worktreePath: string): number | null {
    return this.state().get(worktreePath)?.selectedActionId ?? null;
  }

  getRunningCount(worktreePath: string): number {
    return this.getActions(worktreePath).filter(action => action.status === 'running').length;
  }

  isPanelOpen(worktreePath: string): boolean {
    return this.panelOpen().get(worktreePath) ?? false;
  }

  togglePanel(worktreePath: string): void {
    this.setPanelOpen(worktreePath, !this.isPanelOpen(worktreePath));
  }

  setPanelOpen(worktreePath: string, open: boolean): void {
    const next = new Map(this.panelOpen());
    next.set(worktreePath, open);
    this.panelOpen.set(next);
    this.savePanelState(next);
  }

  async loadActions(worktreePath: string): Promise<Action[]> {
    const actions = await firstValueFrom(this.api.listByWorktree(worktreePath));
    this.replaceActions(worktreePath, actions);
    return actions;
  }

  replaceActions(worktreePath: string, actions: Action[]): void {
    const next = new Map(this.state());
    const existingSelected = next.get(worktreePath)?.selectedActionId ?? null;
    const selectedActionId = actions.some(action => action.id === existingSelected)
      ? existingSelected
      : actions[0]?.id ?? null;

    next.set(worktreePath, {
      actions,
      selectedActionId,
    });
    this.state.set(next);
  }

  setSelectedAction(worktreePath: string, actionId: number | null): void {
    const next = new Map(this.state());
    const existing = next.get(worktreePath) ?? { actions: [], selectedActionId: null };
    next.set(worktreePath, { ...existing, selectedActionId: actionId });
    this.state.set(next);
  }

  upsertAction(worktreePath: string, action: Action): void {
    const next = new Map(this.state());
    const existing = next.get(worktreePath) ?? { actions: [], selectedActionId: null };
    const found = existing.actions.some(item => item.id === action.id);
    const actions = found
      ? existing.actions.map(item => item.id === action.id ? action : item)
      : [...existing.actions, action];
    next.set(worktreePath, {
      actions,
      selectedActionId: existing.selectedActionId ?? action.id,
    });
    this.state.set(next);
  }

  removeAction(worktreePath: string, actionId: number): void {
    const next = new Map(this.state());
    const existing = next.get(worktreePath);
    if (!existing) return;

    const actions = existing.actions.filter(action => action.id !== actionId);
    next.set(worktreePath, {
      actions,
      selectedActionId: existing.selectedActionId === actionId ? (actions[0]?.id ?? null) : existing.selectedActionId,
    });
    this.state.set(next);
  }

  updateActionStatus(worktreePath: string, actionId: number, status: Action['status'], currentOutput?: string): void {
    const next = new Map(this.state());
    const existing = next.get(worktreePath);
    if (!existing) return;

    next.set(worktreePath, {
      ...existing,
      actions: existing.actions.map(action => {
        if (action.id !== actionId) return action;
        return {
          ...action,
          status,
          currentOutput: currentOutput ?? action.currentOutput,
          updatedAt: new Date().toISOString(),
        };
      }),
    });
    this.state.set(next);
  }

  private loadPanelState(): Map<string, boolean> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        return new Map(Object.entries(data.panelOpen ?? {}));
      }
    } catch {
      // Ignore storage errors.
    }

    return new Map();
  }

  private savePanelState(panelOpen: Map<string, boolean>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        panelOpen: Object.fromEntries(panelOpen),
      }));
    } catch {
      // Ignore storage errors.
    }
  }
}
