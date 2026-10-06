import { promises as fs } from 'node:fs';

/** Only a confirmed absent directory should trigger removal of saved state. */
export async function isMissingWorktreePath(value: string): Promise<boolean> {
  try {
    return !(await fs.stat(value)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}
