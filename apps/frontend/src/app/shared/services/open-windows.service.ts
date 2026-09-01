import { Injectable, computed, signal } from '@angular/core';

import {
  ElectronEnvironmentRef,
  ElectronWindowSummary,
  getElectronWindowsApi,
} from '@/shared/runtime/electron-windows';
import { getWindowId } from '@/shared/runtime/window-context';

import {
  ENVIRONMENT_CATALOGUE_CHANGED_CHANNEL,
  OnboardingStateService,
} from './onboarding-state.service';
import { pruneOrphanWindowScopes } from './scoped-storage';

/**
 * Live view of every open Elevenex window and the environment it is bound to.
 *
 * Two things need it. The environment switcher, to show which environments are
 * already open elsewhere and to offer focusing them instead of duplicating
 * them; and the delete guard, because a saved server that another window is
 * actively connected to must not be removable from under it.
 */
@Injectable({ providedIn: 'root' })
export class OpenWindowsService {
  private readonly api = getElectronWindowsApi();
  private readonly windowsSignal = signal<ElectronWindowSummary[]>([]);

  readonly windows = this.windowsSignal.asReadonly();
  readonly currentWindowId = getWindowId();
  readonly isMultiWindowSupported = this.api !== null;
  readonly hasOtherWindows = computed(() => this.windowsSignal().length > 1);

  constructor(private readonly onboardingState: OnboardingStateService) {
    if (!this.api) {
      return;
    }

    this.api.onChanged((windows) => this.applyWindows(windows));
    this.api.onBroadcast((message) => {
      if (message?.channel === ENVIRONMENT_CATALOGUE_CHANGED_CHANNEL) {
        this.onboardingState.refreshFromStorage();
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.api) {
      return;
    }

    try {
      this.applyWindows(await this.api.list());
    } catch {
      // A momentarily unavailable main process is not worth surfacing.
    }
  }

  /** Windows other than this one that are bound to the given environment. */
  othersOn(env: Pick<ElectronEnvironmentRef, 'mode' | 'serverId'>): ElectronWindowSummary[] {
    return this.windowsSignal().filter(
      (entry) =>
        entry.windowId !== this.currentWindowId
        && entry.envRef.mode === env.mode
        && (env.mode !== 'ssh' || entry.envRef.serverId === env.serverId),
    );
  }

  isOpenElsewhere(env: Pick<ElectronEnvironmentRef, 'mode' | 'serverId'>): boolean {
    return this.othersOn(env).length > 0;
  }

  async openWindow(env: ElectronEnvironmentRef): Promise<boolean> {
    if (!this.api) {
      return false;
    }

    try {
      await this.api.openNew(env);
      return true;
    } catch {
      return false;
    }
  }

  async focusWindow(windowId: string): Promise<boolean> {
    if (!this.api) {
      return false;
    }

    try {
      return await this.api.focus(windowId);
    } catch {
      return false;
    }
  }

  private applyWindows(windows: ElectronWindowSummary[]): void {
    const next = Array.isArray(windows) ? windows : [];
    this.windowsSignal.set(next);

    // The main process is the only authority on which windows exist, so this
    // is the one moment it is safe to drop the storage of windows that are
    // gone. See pruneOrphanWindowScopes for why that matters.
    pruneOrphanWindowScopes(next.map((entry) => entry.windowId), { authoritative: true });
  }
}
