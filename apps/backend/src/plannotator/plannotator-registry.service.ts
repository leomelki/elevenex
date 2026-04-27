import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { CookieProxyService } from './cookie-proxy.service.js';

export type PlannotatorMode = 'plan' | 'review' | 'annotate' | 'archive';

export interface RegisterOpenPayload {
  sessionId: number;
  url: string;
  pid?: number;
  openedAt?: string;
}

export interface RegisterClosePayload {
  sessionId: number;
  upstreamPort?: number;
}

export interface RegisterOpenResult {
  ok: boolean;
  reason?: string;
  sessionId?: number;
  upstreamPort?: number;
  proxyUrl?: string;
}

export interface DiscoveredOpenPayload {
  sessionId: number;
  url: string;
  openedAt?: string;
}

export interface PlannotatorPanelSnapshot {
  sessionId: number;
  url: string;
  proxyUrl: string;
  upstreamPort: number;
  mode: PlannotatorMode;
  openedAt: string;
}

interface ManagedLaunchState {
  sessionId: number;
  generation: number;
  worktreePath: string;
  active: boolean;
  panel: PlannotatorPanelSnapshot | null;
  lastClosedGeneration: number | null;
}

@Injectable()
export class PlannotatorRegistryService extends EventEmitter {
  private readonly logger = new Logger('PlannotatorRegistry');
  private readonly launches = new Map<number, ManagedLaunchState>();

  constructor(private readonly cookieProxy: CookieProxyService) {
    super();
  }

  registerLaunch(
    sessionId: number,
    worktreePath: string,
    options: { reuseExisting?: boolean } = {},
  ): number {
    const existing = this.launches.get(sessionId);
    const generation =
      options.reuseExisting && existing
        ? existing.generation
        : (existing?.generation ?? 0) + 1;

    this.launches.set(sessionId, {
      sessionId,
      generation,
      worktreePath,
      active: true,
      panel: options.reuseExisting ? existing?.panel ?? null : null,
      lastClosedGeneration: options.reuseExisting ? existing?.lastClosedGeneration ?? null : null,
    });

    this.logger.log(
      `Registered launch for session ${sessionId}, generation ${generation}, reuse=${options.reuseExisting ? 'yes' : 'no'}`,
    );

    return generation;
  }

  markLaunchInactive(sessionId: number): void {
    const state = this.launches.get(sessionId);
    if (!state) {
      return;
    }

    state.active = false;
    this.logger.log(`Marked launch inactive for session ${sessionId}`);
  }

  clearSession(sessionId: number): void {
    const state = this.launches.get(sessionId);
    if (!state) {
      return;
    }

    if (state.panel) {
      this.cookieProxy.clearUpstream(state.panel.upstreamPort);
      this.emit('panel-closed', {
        sessionId,
        upstreamPort: state.panel.upstreamPort,
      });
    }

    this.launches.delete(sessionId);
  }

  registerOpen(payload: RegisterOpenPayload): RegisterOpenResult {
    const state = this.launches.get(payload.sessionId);
    if (!state || !state.active) {
      return { ok: false, reason: 'session-not-active' };
    }

    if (state.lastClosedGeneration === state.generation) {
      return { ok: false, reason: 'panel-closed-for-current-launch' };
    }

    return this.upsertPanel(payload);
  }

  registerDiscoveredOpen(payload: DiscoveredOpenPayload): RegisterOpenResult {
    return this.upsertPanel(payload);
  }

  registerClose(payload: RegisterClosePayload): boolean {
    return this.closePanel(payload.sessionId, payload.upstreamPort ?? null);
  }

  handleProxyClose(upstreamPort: number): void {
    for (const state of this.launches.values()) {
      if (state.panel?.upstreamPort === upstreamPort) {
        this.closePanel(state.sessionId, upstreamPort);
        return;
      }
    }
  }

  handleClientClose(sessionId: number): PlannotatorPanelSnapshot | null {
    const state = this.launches.get(sessionId);
    if (!state?.panel) {
      return null;
    }

    const panel = state.panel;
    this.closePanel(sessionId, panel.upstreamPort);
    return panel;
  }

  getActivePanels(): PlannotatorPanelSnapshot[] {
    const panels: PlannotatorPanelSnapshot[] = [];
    for (const state of this.launches.values()) {
      if (state.panel) {
        panels.push(state.panel);
      }
    }
    return panels;
  }

  getSessionIdByUpstreamPort(upstreamPort: number): number | null {
    for (const state of this.launches.values()) {
      if (state.panel?.upstreamPort === upstreamPort) {
        return state.sessionId;
      }
    }

    return null;
  }

  private upsertPanel(payload: {
    sessionId: number;
    url: string;
    openedAt?: string;
  }): RegisterOpenResult {
    let rewritten;
    try {
      rewritten = this.cookieProxy.rewriteUrl(payload.url);
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }

    this.cookieProxy.initUpstreamCookies(rewritten.upstreamPort);

    const panel: PlannotatorPanelSnapshot = {
      sessionId: payload.sessionId,
      url: payload.url,
      proxyUrl: rewritten.proxyUrl,
      upstreamPort: rewritten.upstreamPort,
      mode: this.inferMode(payload.url),
      openedAt: payload.openedAt || new Date().toISOString(),
    };

    const state = this.launches.get(payload.sessionId);
    const existingPanel = state?.panel;

    if (state) {
      state.panel = panel;
    } else {
      this.launches.set(payload.sessionId, {
        sessionId: payload.sessionId,
        generation: 0,
        worktreePath: '',
        active: false,
        panel,
        lastClosedGeneration: null,
      });
    }

    if (
      existingPanel?.upstreamPort === panel.upstreamPort &&
      existingPanel.proxyUrl === panel.proxyUrl
    ) {
      return {
        ok: true,
        sessionId: panel.sessionId,
        upstreamPort: panel.upstreamPort,
        proxyUrl: panel.proxyUrl,
      };
    }

    this.emit('panel-opened', panel);

    return {
      ok: true,
      sessionId: panel.sessionId,
      upstreamPort: panel.upstreamPort,
      proxyUrl: panel.proxyUrl,
    };
  }

  private closePanel(sessionId: number, upstreamPort: number | null): boolean {
    const state = this.launches.get(sessionId);
    if (!state?.panel) {
      return false;
    }

    if (upstreamPort !== null && state.panel.upstreamPort !== upstreamPort) {
      return false;
    }

    const panel = state.panel;
    state.panel = null;
    state.lastClosedGeneration = state.generation;
    this.cookieProxy.clearUpstream(panel.upstreamPort);

    this.emit('panel-closed', {
      sessionId,
      upstreamPort: panel.upstreamPort,
    });

    return true;
  }

  private inferMode(url: string): PlannotatorMode {
    try {
      const parsed = new URL(url);
      const mode = parsed.searchParams.get('mode');
      if (mode === 'plan' || mode === 'review' || mode === 'annotate' || mode === 'archive') {
        return mode;
      }

      const pathname = parsed.pathname.toLowerCase();
      if (pathname.includes('review')) return 'review';
      if (pathname.includes('annotate')) return 'annotate';
      if (pathname.includes('archive')) return 'archive';
    } catch {
      // Ignore parse errors and use default mode.
    }

    return 'plan';
  }
}
