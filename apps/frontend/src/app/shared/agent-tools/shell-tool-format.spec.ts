import { describe, expect, it } from 'vitest';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import {
  parseTerminalOutput,
  shellToolView,
  terminalPlainText,
  terminalWindow,
} from './shell-tool-format';

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
      output: 'PASS\n<script>unsafe</script>',
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

describe('parseTerminalOutput', () => {
  it('keeps SGR colors and decorations as bounded style values', () => {
    const [line] = parseTerminalOutput(
      '\u001b[1;31mERR\u001b[0m plain \u001b[38;5;208mor\u001b[38;2;10;20;30mtc\u001b[0m \u001b[92;44mx\u001b[0m',
    );
    expect(line).toEqual([
      { text: 'ERR', fg: 'var(--terminal-red)', bg: null, decoration: 'cw-term--bold' },
      { text: ' plain ', fg: null, bg: null, decoration: '' },
      { text: 'or', fg: 'rgb(255, 135, 0)', bg: null, decoration: '' },
      { text: 'tc', fg: 'rgb(10, 20, 30)', bg: null, decoration: '' },
      { text: ' ', fg: null, bg: null, decoration: '' },
      {
        text: 'x',
        fg: 'var(--terminal-bright-green)',
        bg: 'var(--terminal-blue)',
        decoration: '',
      },
    ]);
  });
  it('applies carriage-return overwrites and drops other control sequences', () => {
    const lines = parseTerminalOutput(
      'progress 10%\rprogress 100%\r\n\u001b]8;;https://x\u0007link\u001b]8;;\u0007 \u001b]0;title\u0007ok\u0007\nkept\r',
    );
    expect(terminalPlainText(lines)).toBe('progress 100%\nlink ok\nkept');
    expect(parseTerminalOutput('')).toEqual([]);
    expect(parseTerminalOutput('a\n\nb\n')).toHaveLength(3);
  });
});

describe('terminalWindow', () => {
  it('renders the last 2000 lines by default and up to 20000 when expanded', () => {
    const lines = parseTerminalOutput(
      Array.from({ length: 25_000 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    const tail = terminalWindow(lines, false);
    expect(tail.hidden).toBe(23_000);
    expect(terminalPlainText(tail.lines).startsWith('line 23001\n')).toBe(true);
    expect(terminalWindow(lines, true).hidden).toBe(5_000);
    expect(terminalWindow(lines.slice(0, 10), false)).toEqual({
      lines: lines.slice(0, 10),
      hidden: 0,
    });
  });
});
