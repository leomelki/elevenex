import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItem } from './desktop-chat-projection.js';

const command: AgentTranscriptItem = {
  id: 'command', kind: 'tool_use', timestamp: '2026-11-01T12:00:00Z',
  toolKind: 'bash', toolInput: { command: 'pnpm test', cwd: '/repo' },
};
const result = (providerToolResult: unknown): AgentTranscriptItem => ({
  id: 'result', kind: 'tool_result', timestamp: command.timestamp,
  content: 'test output', providerToolResult,
});

describe('desktop command facts', () => {
  it('retains reported exit and workspace separately from readable output', () => {
    const value = chatItem(result({ exit_code: -1, private: 'discard' }), command);
    expect(value.text).toBe('test output');
    expect(value.execution).toEqual({ exitCode: -1, cwd: '/repo' });
    expect(value.error).toBe(true);
    expect(chatItem(command).execution).toEqual({ cwd: '/repo' });
  });

  it('marks an interrupted command as unsuccessful without changing legacy data', () => {
    const raw = result({ interrupted: true, exitCode: 0 });
    expect(chatItem(raw, command)).toMatchObject({
      error: true, execution: { interrupted: true, exitCode: 0 },
    });
    expect(raw.isError).toBeUndefined();
  });

  it('keeps absent facts unknown and drops malformed or unrelated metadata', () => {
    const withoutCwd = { ...command, toolInput: { command: 'pnpm test' } };
    expect(chatItem(result(undefined), withoutCwd).execution).toBeUndefined();
    expect(chatItem(result({ exitCode: NaN, interrupted: 'false', cwd: 'x'.repeat(4001) }), withoutCwd).execution).toBeUndefined();
    expect(chatItem(result({ exitCode: 0 }), { ...command, toolKind: 'mcp', toolInput: {} }).execution).toBeUndefined();
  });
});
