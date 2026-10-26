import type { EnvironmentSelection } from './remote';

/** Opaque lease for one window and one ready backend generation; never persist it. */
export interface BackendScope {
  readonly id: string;
  readonly environment: EnvironmentSelection;
}

/** Ordered per window, including across renderer reloads. Null means unavailable. */
export interface BackendClientState {
  readonly revision: number;
  readonly scope: BackendScope | null;
}

export interface BackendInfo {
  readonly backendSha: string;
}

export interface BackendClientError {
  readonly code: 'unavailable' | 'stale-scope' | 'timeout' | 'transport' | 'http' | 'invalid-response';
  /** Safe, bounded text owned by the adapter; never a raw backend body or URL. */
  readonly message: string;
  readonly status?: number;
}

/** Expected failures survive Electron IPC without depending on Error serialization. */
export type BackendResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BackendClientError };
