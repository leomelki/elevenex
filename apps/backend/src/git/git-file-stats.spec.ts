import nodeFs, { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearWorktreeTextStats,
  readWorktreeTextStats,
} from './git-file-stats.js';

describe('shared worktree text statistics', () => {
  it('coalesces content reads, retains unchanged paths, and verifies replacement versions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-stats-'));
    try {
      await fs.writeFile(path.join(root, 'file'), 'one\ntwo\n');
      const streams = jest.spyOn(nodeFs, 'createReadStream');
      const values = await Promise.all(
        Array.from({ length: 16 }, () => readWorktreeTextStats(root, 'file')),
      );
      expect(values.every((value) => value.lines === 2)).toBe(true);
      expect(streams).toHaveBeenCalledTimes(1);
      await fs.writeFile(path.join(root, 'other'), 'unrelated\n');
      expect((await readWorktreeTextStats(root, 'file')).lines).toBe(2);
      expect(streams).toHaveBeenCalledTimes(1);
      await fs.writeFile(
        path.join(root, 'replacement'),
        Buffer.from([0, 1, 2]),
      );
      await fs.rename(path.join(root, 'replacement'), path.join(root, 'file'));
      expect((await readWorktreeTextStats(root, 'file')).binary).toBe(true);
      expect(streams).toHaveBeenCalledTimes(2);
      clearWorktreeTextStats(root);
      await readWorktreeTextStats(root, 'file');
      expect(streams).toHaveBeenCalledTimes(3);
    } finally {
      jest.restoreAllMocks();
      clearWorktreeTextStats(root);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
