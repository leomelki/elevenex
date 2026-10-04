import { CodexHistoryService } from './codex-history.service.js';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CodexHistoryService', () => {
  it('restores native web searches with all queries and a completion receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      await writeFile(
        join(root, 'thread-search.jsonl'),
        jsonl([
          { type: 'session_meta', payload: { id: 'search' } },
          {
            type: 'response_item',
            payload: {
              id: 'search-1',
              type: 'web_search_call',
              status: 'completed',
              action: {
                type: 'search',
                queries: ['first question', 'second question'],
              },
            },
          },
        ]),
      );
      const history = await new CodexHistoryService(root).getHistory('search');
      expect(history).toEqual([
        expect.objectContaining({
          kind: 'tool_use',
          toolUseId: 'search-1',
          toolKind: 'web_search',
          toolInput: expect.objectContaining({
            query: 'first question\nsecond question',
          }),
        }),
        expect.objectContaining({
          kind: 'tool_result',
          toolUseId: 'search-1',
          content: '',
          isError: false,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function turnRecords(id: string, prompt: string) {
    return [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
      { type: 'turn_context', payload: { turn_id: id } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ text: `answer: ${prompt}` }],
        },
      },
    ];
  }

  function jsonl(records: unknown[]) {
    return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  }

  it('replays rollbacks without renumbering surviving edit and fork anchors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      await writeFile(
        join(root, 'thread-rewound.jsonl'),
        jsonl([
          { type: 'session_meta', payload: { id: 'rewound' } },
          ...turnRecords('turn-1', 'first'),
          ...turnRecords('turn-2', 'obsolete'),
          ...turnRecords('turn-3', 'also obsolete'),
          {
            type: 'event_msg',
            payload: { type: 'thread_rolled_back', num_turns: 2 },
          },
          ...turnRecords('turn-4', 'replacement'),
        ]),
      );
      const history = await service.getHistory('rewound');
      expect(history.map((item) => item.content)).toEqual([
        'first',
        'answer: first',
        'replacement',
        'answer: replacement',
      ]);
      expect(
        history
          .filter((item) => item.kind === 'user')
          .map((item) => item.sourceMessageId),
      ).toEqual(['codex-record:2', 'codex-record:15']);
      await expect(
        service.rewindHistory('rewound', 'codex-record:15'),
      ).resolves.toEqual({ threadId: 'rewound', beforeTurnId: 'turn-4' });
      await expect(
        service.rewindHistory('rewound', 'codex-record:6'),
      ).rejects.toThrow('Only user messages');
      await expect(service.listSessions()).resolves.toEqual([
        expect.objectContaining({ messageCount: 2, summary: 'replacement' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('handles repeated rollbacks and an empty first-turn rewind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      const path = join(root, 'thread-rewound.jsonl');
      await writeFile(
        path,
        jsonl([
          { type: 'session_meta', payload: { id: 'rewound' } },
          ...turnRecords('turn-1', 'first'),
          ...turnRecords('turn-2', 'second'),
          {
            type: 'event_msg',
            payload: { type: 'thread_rolled_back', num_turns: 1 },
          },
          ...turnRecords('turn-3', 'third'),
          {
            type: 'event_msg',
            payload: { type: 'thread_rolled_back', num_turns: 2 },
          },
        ]),
      );
      await expect(service.getHistory('rewound')).resolves.toEqual([]);
      await expect(service.waitForHistory('rewound', 0, path)).resolves.toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for delayed rollout creation and rollback persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      const path = join(root, 'thread-fork.jsonl');
      const waiting = service.waitForHistory('fork', 1, path);
      await writeFile(
        path,
        jsonl([
          { type: 'session_meta', payload: { id: 'fork' } },
          ...turnRecords('turn-1', 'first'),
          ...turnRecords('turn-2', 'second'),
        ]),
      );
      const writeRollback = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          appendFile(
            path,
            jsonl([
              {
                type: 'event_msg',
                payload: { type: 'thread_rolled_back', num_turns: 1 },
              },
            ]),
          ).then(() => resolve(), reject);
        }, 75);
      });
      const [history] = await Promise.all([waiting, writeRollback]);
      expect(history.map((item) => item.content)).toEqual([
        'first',
        'answer: first',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lists a fork under its own metadata id when it contains parent metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      await writeFile(
        join(root, 'thread-fork.jsonl'),
        jsonl([
          { type: 'session_meta', payload: { id: 'fork', cwd: '/repo' } },
          { type: 'session_meta', payload: { id: 'parent', cwd: '/repo' } },
          ...turnRecords('turn-1', 'first'),
        ]),
      );
      await expect(service.listSessions()).resolves.toEqual([
        expect.objectContaining({ id: 'fork', messageCount: 1 }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('normalizes restored request_user_input calls as question tools', () => {
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
        id: 'call-question',
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'question-1',
        arguments: JSON.stringify({
          questions: [{ id: 'scope', question: 'Which scope?', options: [] }],
        }),
      },
      '2026-05-22T10:00:00.000Z',
      0,
    );

    expect(item).toMatchObject({
      kind: 'tool_use',
      toolUseId: 'question-1',
      toolKind: 'ask_user_question',
      toolDisplayName: 'Question',
      toolInput: {
        questions: [{ id: 'scope', question: 'Which scope?', options: [] }],
      },
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

  it('restores user messages from the current Codex item_completed format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      await writeFile(
        join(root, 'thread-modern.jsonl'),
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: 'modern-thread', cwd: '/repo' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              id: 'internal-context',
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'hidden runtime context' }],
            },
          }),
          JSON.stringify({
            type: 'event_msg',
            timestamp: '2026-09-12T00:00:00.000Z',
            payload: {
              type: 'item_completed',
              item: {
                type: 'UserMessage',
                id: 'user-1',
                content: [
                  {
                    type: 'text',
                    text: 'visible user prompt',
                    text_elements: [],
                  },
                ],
              },
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await expect(service.getHistory('modern-thread')).resolves.toEqual([
        expect.objectContaining({
          kind: 'user',
          content: 'visible user prompt',
          sourceMessageId: 'codex-record:2',
          transcriptMessageId: 'codex-record:2',
          timestamp: '2026-09-12T00:00:00.000Z',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves an inclusive app-server fork target for assistant anchors', async () => {
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
            payload: { type: 'task_started', turn_id: 'turn-1' },
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
        anchorMessageId: 'codex-record:3',
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      });

      expect(result).toEqual({
        threadId: 'source-thread',
        lastTurnId: 'turn-1',
        draft: null,
        anchorExcerpt: 'hi',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves an exclusive app-server fork target for user anchors', async () => {
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
            payload: { type: 'task_started', turn_id: 'turn-1' },
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
            type: 'turn_context',
            payload: { turn_id: 'turn-2' },
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
        anchorMessageId: 'codex-record:5',
        anchorMessageKind: 'user',
        childSessionName: 'Fork',
      });

      expect(result).toEqual({
        threadId: 'source-thread',
        beforeTurnId: 'turn-2',
        draft: 'retry this',
        anchorExcerpt: 'retry this',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the owning turn when rewinding before a user message', async () => {
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
            payload: { type: 'task_started', turn_id: 'turn-1' },
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
            type: 'turn_context',
            payload: { turn_id: 'turn-2' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'edit this' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              item: {
                id: 'assistant-2',
                type: 'message',
                role: 'assistant',
                content: [{ text: 'old answer' }],
              },
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const rewindTarget = await service.rewindHistory(
        'source-thread',
        'codex-record:5',
      );

      expect(rewindTarget).toEqual({
        threadId: 'source-thread',
        beforeTurnId: 'turn-2',
      });
      const raw = await readFile(join(root, 'thread-source.jsonl'), 'utf8');
      expect(raw).toContain('edit this');
      expect(raw).toContain('old answer');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the turn id attached to a current-format Codex user item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-'));
    try {
      const service = new CodexHistoryService(root);
      await writeFile(
        join(root, 'thread-modern.jsonl'),
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: 'modern-thread', cwd: '/repo' },
          }),
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              turn_id: 'modern-turn',
              item: {
                type: 'UserMessage',
                id: 'user-1',
                content: [{ type: 'text', text: 'edit this' }],
              },
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await expect(
        service.rewindHistory('modern-thread', 'codex-record:1'),
      ).resolves.toEqual({
        threadId: 'modern-thread',
        beforeTurnId: 'modern-turn',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects rewinding from a non-user Codex record', async () => {
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
            type: 'response_item',
            payload: {
              item: {
                id: 'assistant-1',
                type: 'message',
                role: 'assistant',
                content: [{ text: 'answer' }],
              },
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await expect(
        service.rewindHistory('source-thread', 'codex-record:1'),
      ).rejects.toThrow('Only user messages can be edited.');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
