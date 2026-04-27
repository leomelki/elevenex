import { Injectable, signal, computed } from '@angular/core';

export interface PanelState {
  scratchpad: boolean;
  todos: boolean;
}

const STORAGE_KEY = 'elevenex-panel-states';

@Injectable({ providedIn: 'root' })
export class ProductivityStateService {
  // Signal-based state for reactivity
  private panelStates = signal<Map<number, PanelState>>(this.loadFromStorage());

  private loadFromStorage(): Map<number, PanelState> {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
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
        localStorage.removeItem(STORAGE_KEY);
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
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