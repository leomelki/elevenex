import { promises as fs } from 'node:fs';

export const ACTION_LOG_BYTES = 1024 * 1024;
export const ACTION_OUTPUT_CHARS = 50_000;

/** Read a fixed-size suffix, including when recovering an old, unbounded log. */
async function readTailSnapshot(filePath: string, maxBytes: number) {
  const file = await fs.open(filePath, 'r');
  try {
    const { size, ino, dev } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    let bytesRead = 0;
    const start = Math.max(0, size - buffer.length);
    while (bytesRead < buffer.length) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      );
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    return { buffer: buffer.subarray(0, bytesRead), endOffset: size, ino, dev };
  } finally {
    await file.close();
  }
}

export async function readFileTail(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  return (await readTailSnapshot(filePath, maxBytes)).buffer;
}

/** Output and resume offset come from the same open file and captured end. */
export async function readActionLogSnapshot(
  logPath: string,
): Promise<{ output: string; endOffset: number }> {
  const limit = ACTION_OUTPUT_CHARS * 4;
  const current = await readTailSnapshot(logPath, limit);
  const previous =
    current.buffer.length < limit
      ? await readTailSnapshot(
          `${logPath}.1`,
          limit - current.buffer.length,
        ).catch(() => null)
      : null;
  // Rotation may move our open current file to .1 while we read it.
  const prefix =
    previous && (previous.ino !== current.ino || previous.dev !== current.dev)
      ? previous.buffer
      : Buffer.alloc(0);
  return {
    output: Buffer.concat([prefix, current.buffer])
      .toString('utf8')
      .slice(-ACTION_OUTPUT_CHARS),
    endOffset: current.endOffset,
  };
}

export async function readActionLog(logPath: string): Promise<string> {
  return (await readActionLogSnapshot(logPath)).output;
}

// Runs independently of the backend, so tmux logging stays capped across restart.
// The pipe's EOF marker is written only after every queued write has drained.
export const ACTION_LOG_WRITER = `
const fs = require('node:fs/promises');
const log = process.argv[1];
const cap = ${ACTION_LOG_BYTES};
(async () => {
  let file = await fs.open(log, 'a');
  let size = (await file.stat()).size;
  await fs.writeFile(log + '.ready', '');
  try {
    for await (const chunk of process.stdin) {
      for (let offset = 0; offset < chunk.length;) {
        if (size >= cap) {
          await file.close();
          await fs.rename(log, log + '.1');
          file = await fs.open(log, 'w');
          size = 0;
        }
        const length = Math.min(cap - size, chunk.length - offset);
        let written = 0;
        while (written < length) {
          const result = await file.write(chunk, offset + written, length - written);
          written += result.bytesWritten;
        }
        offset += length;
        size += length;
      }
    }
  } finally {
    await file.close();
  }
  await fs.writeFile(log + '.done', '');
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export async function removeActionLog(logPath: string): Promise<void> {
  await Promise.all(
    ['', '.1', '.ready', '.done'].map((suffix) =>
      fs.unlink(logPath + suffix).catch(() => undefined),
    ),
  );
}
