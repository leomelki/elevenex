import type { BackendManager } from '../backend/manager';
import type { RemoteManager } from '../remote/manager';
import type { BackendClientState } from '@elevenex/shared';
import { BackendClient, type BackendTarget } from './client';

/** Credentials and endpoint selection stay behind this main-process boundary. */
export function createBackendClient(
  backend: BackendManager, remote: RemoteManager,
  changed: (windowId: number, state: BackendClientState) => void,
): { readonly client: BackendClient; dispose(): void } {
  const client = new BackendClient(windowId => resolveTarget(backend, remote, windowId), changed);
  const stopLocal = backend.subscribe(() => client.refreshAll());
  const stopRemote = remote.subscribe(windowId => client.refresh(windowId));
  return { client, dispose: () => { stopLocal(); stopRemote(); client.dispose(); } };
}

function resolveTarget(backend: BackendManager, remote: RemoteManager, windowId: number): BackendTarget | null {
  const { selection, connection } = remote.snapshot(windowId);
  const status = remote.backendStatus(windowId, backend.snapshot());
  if (status.phase !== 'ready') return null;
  if (selection.kind === 'local') return {
    environment: selection, identity: JSON.stringify(['local', status.version, status.url]),
    url: status.url, version: status.version, headers: {},
  };
  const access = remote.backendAccess(windowId);
  if (!access || connection?.phase !== 'ready') return null;
  return { ...access, version: status.version, environment: selection,
    identity: JSON.stringify(['remote', selection.hostId, connection.generation, connection.instanceId, status.version, access.url]),
  };
}
