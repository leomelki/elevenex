import {
  isElevenexTool,
  isDestructiveElevenexTool,
  DESTRUCTIVE_ELEVENEX_TOOLS,
} from './agent-tool-policy.js';

describe('agent-tool-policy', () => {
  it('recognizes mcp__elevenex__* tools', () => {
    expect(isElevenexTool('mcp__elevenex__project_overview')).toBe(true);
    expect(isElevenexTool('mcp__elevenex__create_session')).toBe(true);
    expect(isElevenexTool('Bash')).toBe(false);
    expect(isElevenexTool('mcp__other__thing')).toBe(false);
  });

  it('flags the destructive elevenex tools', () => {
    expect(isDestructiveElevenexTool('mcp__elevenex__steal_worktree')).toBe(
      true,
    );
    expect(isDestructiveElevenexTool('mcp__elevenex__reset_session')).toBe(
      true,
    );
    expect(isDestructiveElevenexTool('mcp__elevenex__remove_repo')).toBe(true);
    expect(isDestructiveElevenexTool('mcp__elevenex__delete_worktree')).toBe(
      true,
    );
  });

  it('treats safe/mutating elevenex tools as non-destructive', () => {
    expect(isDestructiveElevenexTool('mcp__elevenex__project_overview')).toBe(
      false,
    );
    expect(isDestructiveElevenexTool('mcp__elevenex__create_worktree')).toBe(
      false,
    );
    expect(isDestructiveElevenexTool('mcp__elevenex__prompt_session')).toBe(
      false,
    );
    expect(isDestructiveElevenexTool('mcp__elevenex__create_session')).toBe(
      false,
    );
  });

  it('exposes exactly the four destructive names, fully qualified', () => {
    expect([...DESTRUCTIVE_ELEVENEX_TOOLS].sort()).toEqual([
      'mcp__elevenex__delete_worktree',
      'mcp__elevenex__remove_repo',
      'mcp__elevenex__reset_session',
      'mcp__elevenex__steal_worktree',
    ]);
  });
});
