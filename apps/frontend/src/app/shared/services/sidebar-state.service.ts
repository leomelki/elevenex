import { computed, inject, Injectable, linkedSignal } from '@angular/core';
import { getBackendServerId } from '../runtime/runtime-config';
import { OnboardingStateService } from './onboarding-state.service';

export const SIDEBAR_MIN_WIDTH = 250;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_SESSION_LIST_LIMIT = 8;

const STORAGE_KEY_BASE = 'elevenex-sidebar-state-v1';
const EXPANDED_PREFIX = 'expanded:';
const SESSION_LIMIT_PREFIX = 'session-limit:';
const LEGACY_KEYS = ['elevenex-nav-expanded', 'sidebar-width'];

interface SidebarState {
  expandedKeys: Set<string>;
  sessionListVisibleLimits: Map<string, number>;
  width: number;
}

@Injectable({ providedIn: 'root' })
export class SidebarStateService {
  private readonly onboarding = inject(OnboardingStateService);
  private readonly storagePrefix = computed(
    () => `${STORAGE_KEY_BASE}@${getBackendServerId(this.onboarding.snapshotState())}:`,
  );
  // Restore only on startup or a backend change. Other windows' writes must
  // never open or close nodes in a window the user is already browsing.
  private readonly state = linkedSignal({
    source: this.storagePrefix,
    computation: (prefix) => this.loadState(prefix),
  });

  readonly expandedKeys = computed(() => this.state().expandedKeys);
  readonly sessionListVisibleLimits = computed(() => this.state().sessionListVisibleLimits);
  readonly width = computed(() => this.state().width);

  setExpanded(key: string, expanded: boolean): void {
    this.state.update((state) => {
      const keys = new Set(state.expandedKeys);
      if (expanded) keys.add(key);
      else keys.delete(key);
      return { ...state, expandedKeys: keys };
    });
    this.write(`${EXPANDED_PREFIX}${key}`, expanded ? 'true' : null);
  }

  setSessionListVisibleLimit(key: string, limit: number | null): void {
    this.state.update((state) => {
      const limits = new Map(state.sessionListVisibleLimits);
      if (limit === null) limits.delete(key);
      else limits.set(key, limit);
      return { ...state, sessionListVisibleLimits: limits };
    });
    this.write(`${SESSION_LIMIT_PREFIX}${key}`, limit === null ? null : String(limit));
  }

  setWidth(width: number, persist = true): void {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
    this.state.update((state) => ({ ...state, width: clamped }));
    if (persist) this.write('width', String(clamped));
  }

  private write(key: string, value: string | null): void {
    // Persist only the item the user changed. A whole-tree snapshot from an
    // older window would overwrite another window's newer choices; separate
    // keys also keep simultaneous changes to different nodes independent.
    try {
      const scopedKey = `${this.storagePrefix()}${key}`;
      if (value === null) localStorage.removeItem(scopedKey);
      else localStorage.setItem(scopedKey, value);
    } catch {
      // Keep the current window usable when storage is unavailable or full.
    }
  }

  private loadState(prefix: string): SidebarState {
    const state: SidebarState = {
      expandedKeys: new Set(),
      sessionListVisibleLimits: new Map(),
      width: SIDEBAR_DEFAULT_WIDTH,
    };
    try {
      const legacyKeys: string[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key) continue;
        if (LEGACY_KEYS.some((base) => key === base || key.startsWith(`${base}@`))) {
          legacyKeys.push(key);
        }
        if (!key.startsWith(prefix)) continue;
        const item = key.slice(prefix.length);
        const value = localStorage.getItem(key);
        if (item.startsWith(EXPANDED_PREFIX) && value === 'true') {
          const node = item.slice(EXPANDED_PREFIX.length);
          if (node) state.expandedKeys.add(node);
        } else if (item.startsWith(SESSION_LIMIT_PREFIX)) {
          const node = item.slice(SESSION_LIMIT_PREFIX.length);
          const limit = Number(value);
          if (node && Number.isSafeInteger(limit) && limit > SIDEBAR_SESSION_LIST_LIMIT) {
            state.sessionListVisibleLimits.set(node, limit);
          }
        } else if (item === 'width') {
          const width = Number(value);
          if (Number.isFinite(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH) {
            state.width = width;
          }
        }
      }
      // Replace the old window-scoped memory instead of importing its unreliable
      // expansion snapshots into the new backend-scoped state.
      for (const key of legacyKeys) localStorage.removeItem(key);
    } catch {
      // Missing or invalid memory leaves every node collapsed.
    }
    return state;
  }
}
