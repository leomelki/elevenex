import { Injectable, signal } from '@angular/core';

export interface PlannotatorPanelState {
  sessionId: number;
  proxyUrl: string;
  upstreamPort: number;
  visible: boolean;
  minimized: boolean;
  mode: 'plan' | 'review' | 'annotate' | 'archive';
}

@Injectable({
  providedIn: 'root',
})
export class PlannotatorStateService {
  private _panels = signal<Map<number, PlannotatorPanelState>>(new Map());

  readonly panels = this._panels.asReadonly();

  hasPanel(sessionId: number): boolean {
    return this._panels().has(sessionId);
  }

  getPanel(sessionId: number): PlannotatorPanelState | null {
    return this._panels().get(sessionId) || null;
  }

  isPanelVisible(sessionId: number): boolean {
    const panel = this._panels().get(sessionId);
    return panel?.visible ?? false;
  }

  openPanel(
    sessionId: number,
    proxyUrl: string,
    upstreamPort: number,
    mode: PlannotatorPanelState['mode'] = 'plan',
  ): void {
    const current = this._panels();
    const newMap = new Map(current);
    newMap.set(sessionId, {
      sessionId,
      proxyUrl,
      upstreamPort,
      visible: true,
      minimized: false,
      mode,
    });
    this._panels.set(newMap);
  }

  closePanel(sessionId: number): void {
    const current = this._panels();
    const newMap = new Map(current);
    newMap.delete(sessionId);
    this._panels.set(newMap);
  }

  hidePanel(sessionId: number): void {
    const current = this._panels();
    const panel = current.get(sessionId);
    if (panel) {
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, visible: false });
      this._panels.set(newMap);
    }
  }

  showPanel(sessionId: number): void {
    const current = this._panels();
    const panel = current.get(sessionId);
    if (panel) {
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, visible: true });
      this._panels.set(newMap);
    }
  }

  togglePanel(sessionId: number): void {
    const panel = this._panels().get(sessionId);
    if (panel) {
      const current = this._panels();
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, visible: !panel.visible });
      this._panels.set(newMap);
    }
  }

  minimizePanel(sessionId: number): void {
    const current = this._panels();
    const panel = current.get(sessionId);
    if (panel) {
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, minimized: true });
      this._panels.set(newMap);
    }
  }

  restorePanel(sessionId: number): void {
    const current = this._panels();
    const panel = current.get(sessionId);
    if (panel) {
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, minimized: false });
      this._panels.set(newMap);
    }
  }

  isPanelMinimized(sessionId: number): boolean {
    const panel = this._panels().get(sessionId);
    return panel?.minimized ?? false;
  }

  updateProxyUrl(sessionId: number, proxyUrl: string): void {
    const current = this._panels();
    const panel = current.get(sessionId);
    if (panel) {
      const newMap = new Map(current);
      newMap.set(sessionId, { ...panel, proxyUrl });
      this._panels.set(newMap);
    }
  }

  clearAllPanels(): void {
    this._panels.set(new Map());
  }
}
