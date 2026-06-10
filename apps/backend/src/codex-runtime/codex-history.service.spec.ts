import { CodexHistoryService } from './codex-history.service.js';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CodexHistoryService', () => {
  it('marks Codex history plan items with plan content metadata', () => {
    const service = new CodexHistoryService();
    const item = (
      service as unknown as {
        normalizeResponseItem: (
          item: Record<string, unknown>,
          timestamp: string,
          index: number,
        ) => unknown;
      }
    ).normalizeResponseItem(
      { id: 'plan-1', type: 'plan', text: '# Plan\nDo it' },
      '2026-05-22T10:00:00.000Z',
      0,
    );

    expect(item).toMatchObject({
      id: 'plan-1',
      kind: 'assistant',
      contentType: 'plan',
      content: '# Plan\nDo it',
    });
  });

  it('normalizes restored exec_command calls as Bash tool calls', () => {
    const service = new CodexHistoryService();
    const item = (
      service as unknown as {
        normalizeResponseItem: (
          item: Record<string, unknown>,
          timestamp: string,
          index: number,
        ) => unknown;
      }
    ).normalizeResponseItem(
      {
        id: 'call-1',
        type: 'function_call',
        name: 'exec_command',
        call_id: 'tool-1',
        arguments: JSON.stringify({ cmd: 'pnpm test' }),
      },
      '2026-05-22T10:00:00.000Z',
      0,
    );

    expect(item).toMatchObject({
      kind: 'tool_use',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      providerToolName: 'Bash',
      toolKind: 'bash',
      toolDisplayName: 'Bash',
      toolInput: { command: 'pnpm test' },
      providerToolInput: { command: 'pnpm test' },
    });
  });

  it('keeps Codex parsed read actions when restoring exec_command history', () => {
    const service = new CodexHistoryService();
    const commandActions = [
      {
        type: 'read',
        command: "sed -n '1,20p' package.json",
        name: 'package.json',
        path: '/repo/package.json',
      },
    ];
    const item = (
      service as unknown as {
        normalizeResponseItem: (
          item: Record<string, unknown>,
          timestamp: string,
          index: number,
        ) => unknown;
      }
    ).normalizeResponseItem(
      {
        id: 'call-1',
        type: 'function_call',
        name: 'exec_command',
        call_id: 'tool-1',
        arguments: JSON.stringify({
          cmd: "sed -n '1,20p' package.json",
          command_actions: commandActions,
        }),
      },
      '2026-05-22T10:00:00.000Z',
      0,
    );

    expect(item).toMatchObject({
      kind: 'tool_use',
      toolName: 'Bash',
      providerToolName: 'Bash',
      toolKind: 'read',
      toolDisplayName: 'Read',
      toolInput: {
        command: "sed -n '1,20p' package.json",
        file_path: '/repo/package.json',
        commandActions,
      },
      providerToolInput: {
        command: "sed -n '1,20p' package.json",
        commandActions,
      },
    });
  });

  it('clones, slices, and rewrites a Codex JSONL thread for assistant anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      const sourcePath = join(root, 'thread-source.jsonl');
      await writeFile(
        sourcePath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: 'source-thread', cwd: '/repo' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              item: {
                id: 'assistant-1',
                type: 'message',
                role: 'assistant',
                content: [{ text: 'hi' }],
              },
            },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'later' },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const result = await service.forkHistory('source-thread', {
        parentSessionId: 1,
        childSessionId: 2,
        anchorMessageId: 'codex-record:2',
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      });

      expect(result.providerSessionId).toEqual(expect.any(String));
      expect(result.draft).toBeNull();
      expect(result.anchorExcerpt).toBe('hi');

      const summaries = await service.listSessions();
      const forkSummary = summaries.find(
        (summary) => summary.id === result.providerSessionId,
      );
      expect(forkSummary).toBeTruthy();
      const records = (await readFile(forkSummary!.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records).toHaveLength(3);
      expect((records[0].payload as Record<string, unknown>).id).toBe(
        result.providerSessionId,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a user draft and excludes the selected Codex user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      await writeFile(
        join(root, 'thread-source.jsonl'),
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: 'source-thread', cwd: '/repo' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'first' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              item: {
                id: 'assistant-1',
                type: 'message',
                role: 'assistant',
                content: [{ text: 'done' }],
              },
            },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'retry this' },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const result = await service.forkHistory('source-thread', {
        parentSessionId: 1,
        childSessionId: 2,
        anchorMessageId: 'codex-record:3',
        anchorMessageKind: 'user',
        childSessionName: 'Fork',
      });

      expect(result.draft).toBe('retry this');
      const summaries = await service.listSessions();
      const forkSummary = summaries.find(
        (summary) => summary.id === result.providerSessionId,
      );
      const raw = await readFile(forkSummary!.path, 'utf8');
      expect(raw).toContain('assistant-1');
      expect(raw).not.toContain('retry this');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
