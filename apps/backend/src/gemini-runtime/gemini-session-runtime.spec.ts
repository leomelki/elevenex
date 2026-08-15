import { join, resolve, sep } from 'path';
import { resolveWithinWorktree } from './gemini-session-runtime.js';

const ROOT = resolve(sep === '\\' ? 'C:\\repo\\worktree' : '/repo/worktree');

describe('resolveWithinWorktree', () => {
  it('accepts an absolute path inside the worktree', () => {
    const target = join(ROOT, 'src', 'main.ts');
    expect(resolveWithinWorktree(ROOT, target)).toBe(target);
  });

  it('resolves a relative path against the worktree', () => {
    expect(resolveWithinWorktree(ROOT, 'src/main.ts')).toBe(
      join(ROOT, 'src', 'main.ts'),
    );
  });

  it('accepts a file:// URL inside the worktree', () => {
    const target = join(ROOT, 'a.ts');
    const url = `file://${sep === '\\' ? '/' : ''}${target.replace(/\\/g, '/')}`;
    expect(resolveWithinWorktree(ROOT, url)).toBe(target);
  });

  it('refuses a traversal that escapes the worktree', () => {
    expect(() =>
      resolveWithinWorktree(ROOT, join('..', '..', 'secrets.txt')),
    ).toThrow(/outside the session worktree/);
  });

  it('refuses an absolute path elsewhere on the machine', () => {
    const outside = resolve(
      sep === '\\'
        ? 'C:\\Users\\someone\\.ssh\\id_rsa'
        : '/home/someone/.ssh/id_rsa',
    );
    expect(() => resolveWithinWorktree(ROOT, outside)).toThrow(
      /outside the session worktree/,
    );
  });

  it('refuses a sibling directory that merely shares a prefix', () => {
    // `/repo/worktree-other` must not pass a naive startsWith check.
    expect(() => resolveWithinWorktree(ROOT, `${ROOT}-other/a.ts`)).toThrow(
      /outside the session worktree/,
    );
  });

  it('requires a path', () => {
    expect(() => resolveWithinWorktree(ROOT, '')).toThrow(
      'A file path is required.',
    );
    expect(() => resolveWithinWorktree(ROOT, undefined)).toThrow(
      'A file path is required.',
    );
  });
});
