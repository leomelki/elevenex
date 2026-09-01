import { Injectable, signal, computed } from '@angular/core';
import { migratedWindowScopedKey } from '@/shared/services/scoped-storage';

export interface PanelState {
  scratchpad: boolean;
  todos: boolean;
}

// Which side panels are expanded is window layout, not shared state: two
// windows on the same project should be able to arrange themselves
// differently.
const STORAGE_KEY_BASE = 'elevenex-panel-states';

function storageKey(): string {
  return migratedWindowScopedKey(STORAGE_KEY_BASE);
}

@Injectable({ providedIn: 'root' })
export class ProductivityStateService {
  // Signal-based state for reactivity
  private panelStates = signal<Map<number, PanelState>>(this.loadFromStorage());

  private loadFromStorage(): Map<number, PanelState> {
    try {
      const stored = localStorage.getItem(storageKey());
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, PanelState>;
        const map = new Map<number, PanelState>();
        for (const [projectId, state] of Object.entries(parsed)) {
          // Validate state has required fields
          if (state && typeof state.scratchpad === 'boolean' && typeof state.todos === 'boolean') {
            map.set(Number(projectId), state);
          }
        }
        return map;
      }
    } catch (e) {
      console.warn('Failed to load panel states from localStorage:', e);
      // Clear corrupted data
      try {
        localStorage.removeItem(storageKey());
      } catch {}
    }
    return new Map();
  }

  private persist(): void {
    try {
      const obj: Record<string, PanelState> = {};
      this.panelStates().forEach((state, projectId) => {
        obj[projectId.toString()] = state;
      });
      localStorage.setItem(storageKey(), JSON.stringify(obj));
    } catch (e) {
      console.warn('Failed to persist panel states to localStorage:', e);
    }
  }

  // Expose signal for reactive computed
  readonly states = this.panelStates.asReadonly();

  getPanelState(projectId: number): PanelState {
    const states = this.panelStates();
    return states.get(projectId) ?? { scratchpad: false, todos: false };
  }

  togglePanel(projectId: number, panel: 'scratchpad' | 'todos'): void {
    const states = this.panelStates();
    const current = states.get(projectId) ?? { scratchpad: false, todos: false };
    const newMap = new Map(states);
    newMap.set(projectId, { ...current, [panel]: !current[panel] });
    this.panelStates.set(newMap);
    this.persist();
  }

  setPanelOpen(projectId: number, panel: 'scratchpad' | 'todos', open: boolean): void {
    const states = this.panelStates();
    const current = states.get(projectId) ?? { scratchpad: false, todos: false };
    const newMap = new Map(states);
    newMap.set(projectId, { ...current, [panel]: open });
    this.panelStates.set(newMap);
    this.persist();
  }

  // Close all panels for a project (useful when navigating away)
  closeAllPanels(projectId: number): void {
    const states = this.panelStates();
    if (!states.has(projectId)) return; // Nothing to close
    
    const newMap = new Map(states);
    newMap.set(projectId, { scratchpad: false, todos: false });
    this.panelStates.set(newMap);
    this.persist();
  }
}