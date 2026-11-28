import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { BackendClientState, BackendInfo, BackendResult, ElevenexBridge } from '@elevenex/shared';

/** Override in renderer tests; production always uses the sandboxed preload. */
export const ELEVENEX_BRIDGE = new InjectionToken<ElevenexBridge>('Elevenex bridge', {
  providedIn: 'root', factory: () => window.elevenex,
});

/** One per Angular application/window. Feature stores own domain data and loading. */
@Injectable({ providedIn: 'root' })
export class BackendClientService {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly current = signal<BackendClientState>({ revision: -1, scope: null });
  private disposed = false;
  readonly state = this.current.asReadonly();

  constructor() {
    // Subscribe first. An event may overtake the initial invoke reply.
    const stop = this.bridge.onBackendClientChanged(state => this.accept(state));
    inject(DestroyRef).onDestroy(() => { this.disposed = true; stop(); });
    void this.bridge.backendClientState().then(state => this.accept(state), () => {
      // A late bootstrap failure must not overwrite a newer lifecycle event.
      if (!this.disposed && this.current().revision < 0) this.current.set({ revision: 0, scope: null });
    });
  }

  async info(): Promise<BackendResult<BackendInfo>> {
    const scope = this.current().scope;
    if (this.disposed || !scope) return { ok: false, error: { code: 'unavailable', message: 'The selected backend is not ready.' } };
    let result: BackendResult<BackendInfo>;
    try { result = await this.bridge.backendInfo(scope.id); }
    catch { result = { ok: false, error: { code: 'transport', message: 'Backend connection failed.' } }; }
    if (this.disposed || this.current().scope?.id !== scope.id) {
      return { ok: false, error: { code: 'stale-scope', message: 'The backend changed. Refresh the selected view.' } };
    }
    return result;
  }

  private accept(state: BackendClientState): void {
    if (!this.disposed && state.revision > this.current().revision) this.current.set(state);
  }
}
