import { promises as fs } from 'node:fs';
import { isMissingWorktreePath } from './worktree-path.js';

describe('isMissingWorktreePath', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['ENOENT', 'ENOTDIR'])(
    'recognizes a missing directory (%s)',
    async (code) => {
      jest
        .spyOn(fs, 'stat')
        .mockRejectedValue(Object.assign(new Error('missing'), { code }));
      expect(await isMissingWorktreePath('/worktree')).toBe(true);
    },
  );

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'does not treat filesystem errors as deletion (%s)',
    async (code) => {
      jest
        .spyOn(fs, 'stat')
        .mockRejectedValue(Object.assign(new Error('unavailable'), { code }));
      expect(await isMissingWorktreePath('/worktree')).toBe(false);
    },
  );
});
