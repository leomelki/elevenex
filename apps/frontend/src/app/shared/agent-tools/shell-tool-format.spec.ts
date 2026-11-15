import { describe, expect, it } from 'vitest';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { shellOutputWindow, shellToolView } from './shell-tool-format';

const call: AgentTranscriptItem = {
  id: 'shell',
  kind: 'tool_use',
  toolName: 'Bash',
  toolInput: { command: 'pnpm test' },
  timestamp: '',
};
const result: AgentTranscriptItem = {
  id: 'result',
  kind: 'tool_result',
  content: '',
  timestamp: '',
};

describe('shellToolView', () => {
  it('preserves multiline commands and accepts restored Codex cmd/workdir inputs', () => {
    expect(
      shellToolView(
        {
          ...call,
          toolInput: { cmd: 'cd app\npnpm test', workdir: '/repo', description: 'Run tests' },
        },
        null,
        true,
      ),
    ).toMatchObject({
      command: 'cd app\npnpm test',
      directory: '/repo',
      description: 'Run tests',
      state: 'running',
    });
  });
  it('distinguishes missing history, empty completion, failure and explicit denial', () => {
    expect(shellToolView(call, null, false).state).toBe('incomplete');
    expect(shellToolView(call, result, true)).toMatchObject({
      state: 'done',
      status: 'Completed',
      lineCount: 0,
    });
    expect(shellToolView(call, { ...result, isError: true }, false)).toMatchObject({
      state: 'error',
      status: 'Failed',
    });
    expect(
      shellToolView(
        {
          ...call,
          interaction: {
            kind: 'permission',
            decision: 'denied',
            decisionLabel: 'Deny',
            decisionTone: 'warn',
            remember: false,
            createdAt: '',
            resolvedAt: '',
          },
        },
        null,
        true,
      ),
    ).toMatchObject({ state: 'denied', status: 'Deny' });
  });
  it('uses only numeric provider metadata, without guessing from terminal text', () => {
    expect(
      shellToolView(
        call,
        {
          ...result,
          content: 'Exit 12\nProcess exited with code 7',
          providerToolResult: { exitCode: 0, duration_ms: 65000 },
        },
        false,
      ),
    ).toMatchObject({ state: 'done', status: 'Exit 0', duration: '1m 5s' });
    expect(
      shellToolView(call, { ...result, providerToolResult: { exit_code: 2 } }, false),
    ).toMatchObject({ state: 'error', status: 'Exit 2' });
    expect(
      shellToolView(
        call,
        { ...result, providerToolResult: { exitCode: '2', duration_ms: NaN } },
        false,
      ),
    ).toMatchObject({ status: 'Completed', duration: '' });
  });
  it('retains captured output, strips ANSI and supplies a bounded last-line preview', () => {
    expect(
      shellToolView(
        call,
        { ...result, content: '\u001b[32mPASS\u001b[0m\r\n<script>unsafe</script>\n' },
        false,
      ),
    ).toMatchObject({
      output: 'PASS\n<script>unsafe</script>\n',
      lineCount: 2,
      preview: '<script>unsafe</script>',
    });
    expect(
      shellToolView(
        call,
        {
          ...result,
          providerToolResult: { stdout: 'hello', stderr: 'warning', interrupted: true },
        },
        false,
      ),
    ).toMatchObject({ state: 'interrupted', output: 'hello\nwarning' });
  });
  it('handles malformed optional provider values without losing the receipt', () => {
    expect(
      shellToolView(
        { ...call, toolInput: { command: {}, description: 7 } },
        { ...result, providerToolResult: [] },
        false,
      ),
    ).toMatchObject({ command: '', status: 'Completed' });
  });
});

describe('shellOutputWindow', () => {
  it('shows the last 200 lines and optionally 1000, without altering the source', () => {
    const text = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const window = shellOutputWindow(text, false);
    expect(window.truncated).toBe(true);
    expect(window.text.startsWith('line 1301\n')).toBe(true);
    expect(window.text.endsWith('line 1500\n')).toBe(true);
    expect(shellOutputWindow(text, true).text.startsWith('line 501\n')).toBe(true);
  });
  it('caps a single very long line and keeps small output intact', () => {
    expect(shellOutputWindow('a'.repeat(200_000), false).text.length).toBe(24_000);
    expect(shellOutputWindow('a'.repeat(200_000), true).text.length).toBe(100_000);
    expect(shellOutputWindow('hello\n', false)).toEqual({ text: 'hello\n', truncated: false });
  });
});
