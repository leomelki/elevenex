import { canonicalizeAgentTool } from './agent-tool-normalization.js';

describe('agent-tool-normalization', () => {
  it.each([
    ['Read', { file_path: '/repo/file.ts' }, 'read'],
    ['Write', { file_path: '/repo/file.ts', content: 'hello' }, 'write'],
    ['Edit', { file_path: '/repo/file.ts', old_string: 'a', new_string: 'b' }, 'edit'],
    ['Bash', { command: 'pnpm test' }, 'bash'],
    ['AskUserQuestion', { questions: [{ question: 'Proceed?' }] }, 'ask_user_question'],
    ['EnterPlanMode', {}, 'enter_plan_mode'],
    ['ExitPlanMode', { plan: 'Do it' }, 'exit_plan_mode'],
    ['TodoWrite', { todos: [{ content: 'Ship', status: 'pending' }] }, 'todo_write'],
    ['FileChanges', { changes: [{ path: '/repo/file.ts', kind: 'update' }] }, 'file_changes'],
    ['mcp__server__tool', { server: 'server', arguments: {} }, 'mcp'],
  ])('maps %s to %s', (toolName, input, expectedKind) => {
    expect(canonicalizeAgentTool(toolName, input).toolKind).toBe(expectedKind);
  });

  it('maps Codex parsed read command actions to canonical read input', () => {
    const result = canonicalizeAgentTool('Bash', {
      command: "sed -n '1,20p' package.json",
      commandActions: [
        {
          type: 'read',
          command: "sed -n '1,20p' package.json",
          name: 'package.json',
          path: '/repo/package.json',
        },
      ],
    });

    expect(result.toolKind).toBe('read');
    expect(result.toolInput).toMatchObject({
      file_path: '/repo/package.json',
      command: "sed -n '1,20p' package.json",
    });
  });
});
