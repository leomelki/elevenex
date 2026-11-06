import type { BackendClient } from '../backend-client/client';
import { requestBackendJson } from '../backend-client/transport';
import { transferReply, type TransferOperation } from './transfer-contracts';
import { TransferError } from './transfers';

interface TransferLease { readonly windowId: number; readonly scopeId: string; readonly taskId: number; readonly generation: string }
/** A transfer keeps its original backend lease, including during cleanup. No
 * prompt, chunk or commit is retried when a connection changes. */
export function codeTransferCall(client: BackendClient, lease: TransferLease, current: () => boolean, lifetime: AbortSignal) {
  return async (operation: TransferOperation, body: object, signal: AbortSignal): Promise<unknown> => {
    if (!current()) throw new TransferError('Task connection changed. Start a new transfer after reconnecting.');
    const result = await client.execute(lease.windowId, lease.scopeId, null, operation.startsWith('upload-') || operation === 'mkdir', async (endpoint, cancellation) => requestBackendJson(endpoint, {
      path: `/api/code-workspaces/${lease.taskId}/${operation}`, method: 'POST', body: { ...body, identity: lease.generation }, limit: 512 * 1024,
      conflictMessages: { 'file-conflict': 'A file changed during transfer. Review it before trying again.', 'workspace-changed': 'Task workspace changed.', 'target-exists': 'Destination already exists.' },
    }, cancellation), 30_000, AbortSignal.any([lifetime, signal]));
    if (!result.ok) throw new TransferError(operation === 'upload-commit' && result.error.code !== 'http'
      ? 'Transfer interrupted. A file may have completed. Refresh and review the destination before starting another transfer.'
      : result.error.status === 409 ? result.error.message
      : result.error.status === 404 ? 'Transfer is unavailable on this machine, or a selected file no longer exists. Update the machine and refresh the Explorer.'
      : 'Transfer failed. Check the connection, file permissions and the 2 GiB per-file limit. Completed files were kept.', operation === 'upload-commit');
    if (!current()) throw new TransferError('Task connection changed. Review completed files before starting a new transfer.', operation === 'upload-commit');
    return transferReply(operation, result.value);
  };
}
