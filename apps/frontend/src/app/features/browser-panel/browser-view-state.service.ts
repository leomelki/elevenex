import { Injectable, signal } from '@angular/core';
import { BrowserViewState } from '@/shared/runtime/electron-browser';

export function buildBrowserViewKey(projectId: number, tabId: string): string {
  return `project:${projectId}:tab:${tabId}`;
}

export function buildBrowserViewProjectPrefix(projectId: number): string {
  return `project:${projectId}:tab:`;
}

@Injectable({ providedIn: 'root' })
export class BrowserViewStateService {
  private readonly browserStates = signal<Map<string, BrowserViewState>>(new Map());

  readonly states = this.browserStates.asReadonly();

  getState(key: string): BrowserViewState | null {
    return this.browserStates().get(key) ?? null;
  }

  upsertState(state: BrowserViewState): void {
    this.browserStates.update(current => new Map(current).set(state.key, state));
  }

  removeState(key: string): void {
    this.browserStates.update(current => {
      if (!current.has(key)) {
        return current;
      }

      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }

  removeStatesByPrefix(prefix: string): void {
    this.browserStates.update(current => {
      let changed = false;
      const next = new Map(current);

      for (const key of next.keys()) {
        if (!key.startsWith(prefix)) {
          continue;
        }

        next.delete(key);
        changed = true;
      }

      return changed ? next : current;
    });
  }
}
