import { randomUUID } from 'node:crypto';
import type {
  BackendClientState,
  BackendInfo,
  BackendResult,
  EnvironmentSelection,
} from '@elevenex/shared';
import {
  BackendRequestError,
  readBackendInfo,
  type BackendEndpoint,
} from './transport';

export interface BackendTarget extends BackendEndpoint {
  /** Main-owned identity includes environment, transport generation and instance. */
  readonly identity: string;
  readonly environment: EnvironmentSelection;
}

interface WindowClient {
  state: BackendClientState;
  target: BackendTarget | null;
  operations: Map<
    string,
    {
      readonly controller: AbortController;
      readonly result: Promise<BackendResult<unknown>>;
    }
  >;
  pending?: {
    readonly controller: AbortController;
    readonly result: Promise<BackendResult<BackendInfo>>;
  };
}

/** Window leases over the application-owned backend; owns all in-flight reads. */
export class BackendClient {
  private readonly windows = new Map<number, WindowClient>();
  private disposed = false;

  constructor(
    private readonly resolve: (windowId: number) => BackendTarget | null,
    private readonly changed: (
      windowId: number,
      state: BackendClientState,
    ) => void,
  ) {}

  attach(windowId: number): void {
    if (this.disposed || this.windows.has(windowId)) return;
    this.windows.set(windowId, {
      state: { revision: 0, scope: null },
      target: null,
      operations: new Map(),
    });
    this.refresh(windowId);
  }

  detach(windowId: number): void {
    this.windows.get(windowId)?.pending?.controller.abort();
    for (const pending of this.windows.get(windowId)?.operations.values() ?? [])
      pending.controller.abort();
    this.windows.delete(windowId);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.windows.keys()) this.detach(id);
  }

  /** A new document cannot inherit the previous renderer's outstanding work. */
  reset(windowId: number): void {
    const window = this.windows.get(windowId);
    if (!window) return;
    this.replace(windowId, window, null);
    this.refresh(windowId);
  }

  refresh(windowId: number): void {
    const window = this.windows.get(windowId);
    if (!window) return;
    const target = this.resolve(windowId);
    if (target?.identity === window.target?.identity) return;
    this.replace(windowId, window, target);
  }

  refreshAll(): void {
    for (const id of this.windows.keys()) this.refresh(id);
  }

  state(windowId: number): BackendClientState {
    this.refresh(windowId);
    return this.windows.get(windowId)?.state ?? { revision: 0, scope: null };
  }

  info(windowId: number, scopeId: string): Promise<BackendResult<BackendInfo>> {
    this.refresh(windowId);
    const window = this.windows.get(windowId);
    if (!window?.target || !window.state.scope)
      return Promise.resolve(unavailable());
    if (window.state.scope.id !== scopeId) return Promise.resolve(stale());
    if (window.pending) return window.pending.result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const target = window.target;
    const result = (async (): Promise<BackendResult<BackendInfo>> => {
      try {
        const value = await readBackendInfo(target, controller.signal);
        return { ok: true, value };
      } catch (error) {
        if (controller.signal.aborted)
          return {
            ok: false,
            error: { code: 'timeout', message: 'Backend request timed out.' },
          };
        if (error instanceof BackendRequestError)
          return { ok: false, error: error.detail };
        return {
          ok: false,
          error: { code: 'transport', message: 'Backend connection failed.' },
        };
      } finally {
        clearTimeout(timer);
      }
    })()
      .then((reply) => {
        this.refresh(windowId);
        if (
          this.windows.get(windowId) !== window ||
          window.state.scope?.id !== scopeId
        )
          return stale();
        return reply;
      })
      .finally(() => {
        if (window.pending?.controller === controller)
          window.pending = undefined;
      });
    window.pending = { controller, result };
    return result;
  }

  cancel(windowId: number, scopeId: string, key: string): void {
    this.refresh(windowId);
    const window = this.windows.get(windowId);
    if (window?.state.scope?.id === scopeId) {
      for (const [identity, operation] of window.operations) {
        if (identity === key || identity.startsWith(key + ':')) operation.controller.abort();
      }
    }
  }

  execute<T>(
    windowId: number,
    scopeId: string,
    key: string | null,
    mutation: boolean,
    operation: (endpoint: BackendEndpoint, signal: AbortSignal) => Promise<T>,
    timeoutMs = 10000,
  ): Promise<BackendResult<T>> {
    this.refresh(windowId);
    const window = this.windows.get(windowId);
    if (!window?.target || !window.state.scope)
      return Promise.resolve(unavailable());
    if (window.state.scope.id !== scopeId) return Promise.resolve(stale());
    const identity = mutation || key === null ? randomUUID() : key;
    const existing = window.operations.get(identity);
    if (existing) return existing.result as Promise<BackendResult<T>>;
    if (window.operations.size >= 64)
      return Promise.resolve({
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Too many pending workspace requests. Try again shortly.',
        },
      });
    const controller = new AbortController();
    const target = window.target;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = (async (): Promise<BackendResult<T>> => {
      try {
        return { ok: true, value: await operation(target, controller.signal) };
      } catch (error) {
        if (
          mutation &&
          (!(error instanceof BackendRequestError) ||
            error.detail.code !== 'http' ||
            (error.detail.status ?? 500) >= 500)
        )
          return {
            ok: false,
            error: {
              code: 'outcome-unknown',
              message:
                'The operation may have completed. Refresh the workspace before trying again.',
            },
          };
        if (controller.signal.aborted)
          return {
            ok: false,
            error: { code: 'timeout', message: 'Backend request timed out.' },
          };
        return error instanceof BackendRequestError
          ? { ok: false, error: error.detail }
          : {
              ok: false,
              error: {
                code: 'transport',
                message: 'Backend connection failed.',
              },
            };
      } finally {
        clearTimeout(timer);
      }
    })()
      .then((reply) => {
        this.refresh(windowId);
        return this.windows.get(windowId) !== window ||
          window.state.scope?.id !== scopeId
          ? stale()
          : reply;
      })
      .finally(() => {
        if (window.operations.get(identity)?.controller === controller)
          window.operations.delete(identity);
      });
    window.operations.set(identity, { controller, result });
    return result;
  }

  private replace(
    windowId: number,
    window: WindowClient,
    target: BackendTarget | null,
  ): void {
    for (const pending of window.operations.values())
      pending.controller.abort();
    window.operations.clear();
    window.pending?.controller.abort();
    window.pending = undefined;
    window.target = target;
    window.state = {
      revision: window.state.revision + 1,
      scope: target
        ? { id: randomUUID(), environment: target.environment }
        : null,
    };
    this.changed(windowId, window.state);
  }
}

function unavailable(): BackendResult<never> {
  return {
    ok: false,
    error: {
      code: 'unavailable',
      message: 'The selected backend is not ready.',
    },
  };
}

function stale(): BackendResult<never> {
  return {
    ok: false,
    error: {
      code: 'stale-scope',
      message: 'The backend changed. Refresh the selected view.',
    },
  };
}
