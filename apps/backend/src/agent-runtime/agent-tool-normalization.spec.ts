import {
  canonicalizeAgentTool,
  stripShellCommandWrapper,
} from './agent-tool-normalization.js';

describe('agent-tool-normalization', () => {
  it.each([
    ['Read', { file_path: '/repo/file.ts' }, 'read'],
    ['Write', { file_path: '/repo/file.ts', content: 'hello' }, 'write'],
    [
      'Edit',
      { file_path: '/repo/file.ts', old_string: 'a', new_string: 'b' },
      'edit',
    ],
    ['Bash', { command: 'pnpm test' }, 'bash'],
    [
      'AskUserQuestion',
      { questions: [{ question: 'Proceed?' }] },
      'ask_user_question',
    ],
    ['EnterPlanMode', {}, 'enter_plan_mode'],
    ['ExitPlanMode', { plan: 'Do it' }, 'exit_plan_mode'],
    [
      'TodoWrite',
      { todos: [{ content: 'Ship', status: 'pending' }] },
      'todo_write',
    ],
    [
      'FileChanges',
      { changes: [{ path: '/repo/file.ts', kind: 'update' }] },
      'file_changes',
    ],
    ['exec_command', { command: 'pnpm test' }, 'bash'],
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

  describe('shell command display', () => {
    it.each([
      [
        '"C:\\windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force"',
        'Get-ChildItem -Force',
      ],
      [
        'powershell.exe -NoLogo -NoProfile -NonInteractive -Command Get-Content README.md',
        'Get-Content README.md',
      ],
      ['/bin/zsh -lc "pnpm test"', 'pnpm test'],
      ["bash -c 'git status --short'", 'git status --short'],
      ['fish -c pnpm lint', 'pnpm lint'],
      ['cmd.exe /d /s /c "pnpm build"', 'pnpm build'],
    ])('strips the command-string wrapper from %s', (command, expected) => {
      expect(stripShellCommandWrapper(command)).toBe(expected);
    });

    it.each([
      'zsh scripts/check.zsh',
      'powershell.exe -File scripts/check.ps1',
      'node -Command "console.log(1)"',
      'echo powershell.exe -Command Get-Date',
      'zsh -x -c "pnpm test"',
    ])('leaves non-wrapper command forms unchanged: %s', (command) => {
      expect(stripShellCommandWrapper(command)).toBe(command);
    });

    it('keeps separate quoted command arguments quoted', () => {
      expect(
        stripShellCommandWrapper(
          'pwsh -Command "Write-Output one" "Write-Output two"',
        ),
      ).toBe('"Write-Output one" "Write-Output two"');
    });

    it('uses the unwrapped command only in canonical run-tool input', () => {
      const providerInput = {
        command: '/bin/zsh -lc "pnpm test"',
        description: 'Run tests',
      };

      const result = canonicalizeAgentTool('exec_command', providerInput);

      expect(result.toolInput).toEqual({
        command: 'pnpm test',
        description: 'Run tests',
      });
      expect(providerInput.command).toBe('/bin/zsh -lc "pnpm test"');
    });
  });
});
