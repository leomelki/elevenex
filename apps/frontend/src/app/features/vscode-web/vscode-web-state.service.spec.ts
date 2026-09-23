import { describe, expect, it } from 'vitest';
import { toWorkspaceRootUri } from './vscode-web-state.service';

describe('toWorkspaceRootUri', () => {
  it('keeps mixed-case filesystem paths out of the hostname authority', () => {
    const worktreePath =
      '/home/bits/go/src/github.com/DataDog/.worktrees/dd-go/fingerprint-migration-investigation';
    const uri = new URL(toWorkspaceRootUri(worktreePath));

    expect(uri.hostname).toBe('elevenex');
    expect(uri.searchParams.get('worktreePath')).toBe(worktreePath);
  });
});
