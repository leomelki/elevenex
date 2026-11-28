import { type TransferCall, TRANSFER_CHUNK, TransferError } from './transfer-contracts';
import { number, object, string } from './validation';

/** Both upload sources stage bytes outside the worktree. Only a complete
 * upload can publish, against the destination revision captured by its caller. */
export async function uploadFile(
  call: TransferCall,
  target: { path: string; size: number; revision: string | null },
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  progress?: (offset: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  const reply = object(await call('upload-begin', target, signal));
  const id = string(reply['id'], 36);
  let committed = false;
  try {
    let offset = 0;
    for await (const chunk of source) {
      for (let index = 0; index < chunk.byteLength; index += TRANSFER_CHUNK) {
        signal.throwIfAborted();
        const bytes = chunk.subarray(index, index + TRANSFER_CHUNK);
        if (offset + bytes.byteLength > target.size) throw new TransferError('Upload received more bytes than expected.');
        const reply = object(await call('upload-chunk', { id, offset, content: Buffer.from(bytes).toString('base64') }, signal));
        offset += bytes.byteLength;
        if (number(reply['offset'], target.size) !== offset) throw new Error('Invalid upload acknowledgement.');
        progress?.(offset);
      }
    }
    if (offset !== target.size) throw new TransferError('Upload ended before all bytes arrived.');
    signal.throwIfAborted();
    await call('upload-commit', { id }, signal);
    committed = true;
  } finally {
    if (!committed) await call('upload-abort', { id }, AbortSignal.timeout(5000)).catch(() => undefined);
  }
}
