import { CodexHistoryService } from './codex-history.service.js';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('CodexHistoryService', () => {
  it('restores the latest child context, ignoring inherited counts, lifetime usage, and rate-limit-only events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-child-context-'));
    const path = join(root, 'rollout-child.jsonl');
    const tokenEvent = (
      timestamp: string,
      total: number,
      window: number | null = 200_000,
    ) => ({
      type: 'event_msg',
      timestamp,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 9_000_000 },
          last_token_usage: {
            input_tokens: total - 1000,
            output_tokens: 1000,
            cached_input_tokens: 500,
            total_tokens: total,
          },
          model_context_window: window,
        },
      },
    });
    try {
      await writeFile(
        path,
        jsonl([
          {
            type: 'session_meta',
            timestamp: '2026-10-12T10:01:00.000Z',
            payload: {
              id: 'child',
              source: {
                subagent: { thread_spawn: { parent_thread_id: 'parent' } },
              },
            },
          },
          tokenEvent('2026-10-12T10:00:00.000Z', 180_000),
        ]),
      );
      const service = new CodexHistoryService(root);
      expect(
        (await service.getSubagentSnapshot('child'))?.contextUsage,
      ).toBeUndefined();
      await appendFile(
        path,
        jsonl([
          {
            type: 'turn_context',
            timestamp: '2026-10-12T10:02:00.000Z',
            payload: { model: 'child-model' },
          },
          tokenEvent('2026-10-12T10:03:00.000Z', 100_000),
          tokenEvent('2026-10-12T10:04:00.000Z', 20_000),
          {
            type: 'event_msg',
            timestamp: '2026-10-12T10:05:00.000Z',
            payload: { type: 'token_count', info: null, rate_limits: {} },
          },
        ]),
      );
      expect(await service.getSubagentSnapshot('child')).toMatchObject({
        contextUsage: {
          model: 'child-model',
          totalTokens: 20_000,
          maxTokens: 200_000,
          percentage: 4,
          inputTokens: 19_000,
          outputTokens: 1000,
        },
        contextUsageUpdatedAt: '2026-10-12T10:04:00.000Z',
      });
      await appendFile(
        path,
        jsonl([tokenEvent('2026-10-12T10:06:00.000Z', 25_000, null)]),
      );
      expect(
        (await service.getSubagentSnapshot('child'))?.contextUsage,
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the child’s own model context rather than a copied parent configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-child-model-'));
    try {
      await writeFile(
        join(root, 'rollout-child.jsonl'),
        jsonl([
          {
            type: 'session_meta',
            timestamp: '2026-10-12T10:01:00.000Z',
            payload: {
              id: 'child',
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: 'parent',
                    agent_path: '/root/review',
                  },
                },
              },
            },
          },
          {
            type: 'turn_context',
            timestamp: '2026-10-12T10:00:00.000Z',
            payload: { model: 'parent-model', effort: 'low' },
          },
          {
            type: 'turn_context',
            timestamp: '2026-10-12T10:02:00.000Z',
            payload: { model: 'child-model', effort: 'high' },
          },
        ]),
      );
      expect(
        await new CodexHistoryService(root).getSubagentSnapshot('child'),
      ).toMatchObject({
        agentPath: '/root/review',
        model: 'child-model',
        reasoningEffort: 'high',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('hides sealed assignment envelopes and trims inherited history at child creation when no readable prompt is saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sealed-assignment-'));
    const encrypted = `gAAAAA${'x'.repeat(400)}`;
    try {
      await writeFile(
        join(root, 'rollout-child.jsonl'),
        jsonl([
          {
            type: 'session_meta',
            timestamp: '2026-10-12T10:01:00.000Z',
            payload: {
              id: 'child',
              source: {
                subagent: { thread_spawn: { parent_thread_id: 'parent' } },
              },
            },
          },
          {
            type: 'event_msg',
            timestamp: '2026-10-12T10:00:00.000Z',
            payload: { type: 'user_message', message: 'Inherited question' },
          },
          {
            type: 'event_msg',
            timestamp: '2026-10-12T10:02:00.000Z',
            payload: {
              type: 'item_completed',
              item: {
                id: 'reply',
                type: 'AgentMessage',
                content: [{ type: 'text', text: 'Checking the cache' }],
              },
            },
          },
          {
            type: 'response_item',
            timestamp: '2026-10-12T10:02:00.100Z',
            payload: {
              type: 'function_call',
              name: 'spawn_agent',
              call_id: 'spawn',
              arguments: JSON.stringify({ message: encrypted }),
            },
          },
          {
            type: 'response_item',
            timestamp: '2026-10-12T10:02:00.200Z',
            payload: {
              type: 'function_call_output',
              call_id: 'spawn',
              output: '{"agent_id":"nested"}',
            },
          },
        ]),
      );
      const snapshot = await new CodexHistoryService(root).getSubagentSnapshot(
        'child',
      );
      expect(
        snapshot?.history.some((item) => item.content === 'Inherited question'),
      ).toBe(false);
      expect(snapshot?.history[0]).toMatchObject({
        kind: 'assistant',
        content: 'Checking the cache',
      });
      expect(snapshot?.subagents[0].prompt).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain(encrypted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('resolves task-path spawn receipts to real child thread IDs with a coalesced metadata index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-task-paths-'));
    try {
      await writeFile(
        join(root, 'rollout-parent.jsonl'),
        jsonl([
          { type: 'session_meta', payload: { id: 'parent' } },
          {
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'spawn_agent',
              call_id: 'spawn',
              arguments: '{"task_name":"review","message":"Review the cache"}',
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'spawn',
              output: '{"task_name":"/root/review"}',
            },
          },
        ]),
      );
      await writeFile(
        join(root, 'rollout-child.jsonl'),
        jsonl([
          {
            type: 'session_meta',
            payload: {
              id: 'child',
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: 'parent',
                    agent_path: '/root/review',
                    agent_nickname: 'Ada',
                  },
                },
              },
            },
          },
        ]),
      );
      const service = new CodexHistoryService(root);
      const [one, two] = await Promise.all([
        service.getSubagentSnapshot('parent'),
        service.getSubagentSnapshot('parent'),
      ]);
      expect(one?.subagents).toEqual([
        expect.objectContaining({
          agentId: 'child',
          agentType: 'review',
          prompt: 'Review the cache',
          parentToolUseId: 'spawn',
        }),
      ]);
      expect(two?.subagents).toEqual(one?.subagents);
      expect((await service.getSubagentSnapshot('child'))?.displayName).toBe(
        'Ada',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('restores child assignments, nicknames, nested agents, and terminal state without inherited parent messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-subagent-history-'));
    const timestamp = '2026-10-12T10:00:00.000Z';
    try {
      await writeFile(
        join(root, 'rollout-child.jsonl'),
        jsonl([
          {
            type: 'session_meta',
            payload: {
              id: 'child',
              source: {
                subagent: {
                  thread_spawn: {
                    parent_thread_id: 'parent',
                    agent_nickname: 'Ada',
                    agent_role: 'explorer',
                  },
                },
              },
            },
          },
          {
            type: 'event_msg',
            timestamp,
            payload: {
              type: 'user_message',
              message: 'Inherited parent question',
            },
          },
          {
            type: 'event_msg',
            timestamp,
            payload: { type: 'user_message', message: 'Inspect tests' },
          },
          {
            type: 'response_item',
            timestamp,
            payload: {
              type: 'function_call',
              name: 'spawn_agent',
              call_id: 'nested-spawn',
              arguments: '{"message":"Verify the race","agent_type":"worker"}',
            },
          },
          {
            type: 'response_item',
            timestamp,
            payload: {
              type: 'function_call_output',
              call_id: 'nested-spawn',
              output: '{"agent_id":"grandchild"}',
            },
          },
          {
            type: 'response_item',
            timestamp,
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ text: 'Found a race' }],
            },
          },
          { type: 'event_msg', timestamp, payload: { type: 'task_complete' } },
        ]),
      );
      const service = new CodexHistoryService(root);
      const snapshot = await service.getSubagentSnapshot(
        'child',
        'Inspect tests',
      );
      expect(snapshot).toMatchObject({
        displayName: 'Ada',
        agentType: 'explorer',
        executionStatus: 'completed',
        lastAssistantMessage: 'Found a race',
      });
      expect(snapshot?.history[0].content).toBe('Inspect tests');
      expect(
        snapshot?.history.some(
          (item) => item.content === 'Inherited parent question',
        ),
      ).toBe(false);
      expect(snapshot?.subagents).toEqual([
        expect.objectContaining({
          agentId: 'grandchild',
          agentType: 'worker',
          prompt: 'Verify the race',
        }),
      ]);
      const read = jest.spyOn(service as any, 'readJsonl');
      await Promise.all([
        service.getHistory('child'),
        service.getSubagentSnapshot('child', 'Inspect tests'),
      ]);
      expect(read).not.toHaveBeenCalled();
      await appendFile(
        join(root, 'rollout-child.jsonl'),
        jsonl([
          {
            type: 'event_msg',
            timestamp: '2026-10-12T10:01:00.000Z',
            payload: { type: 'task_started' },
          },
        ]),
      );
      expect(
        (await service.getSubagentSnapshot('child', 'Inspect tests'))
          ?.executionStatus,
      ).toBe('running');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses a resolved rollout and reloads history after appends and replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-history-cache-'));
    try {
      const service = new CodexHistoryService(root);
      const path = join(root, 'thread-cached.jsonl');
      await writeFile(
        path,
        jsonl([
          { type: 'session_meta', payload: { id: 'cached' } },
          ...turnRecords('first', 'original'),
        ]),
      );
      const scan = jest.spyOn(service as any, 'findJsonlFiles');
      const read = jest.spyOn(service as any, 'readJsonl');
      await service.getHistory('cached');
      await service.getHistory('cached');
      expect(scan).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      await appendFile(path, jsonl(turnRecords('second', 'new prompt')));
      expect(
        (await service.getHistory('cached')).map((item) => item.content),
      ).toContain('new prompt');
      expect(scan).toHaveBeenCalledTimes(1);
      await rm(path);
      const moved = join(root, 'moved-cached.jsonl');
      await writeFile(
        moved,
        jsonl([
          { type: 'session_meta', payload: { id: 'cached' } },
          ...turnRecords('replacement', 'replacement prompt'),
        ]),
      );
      expect(
        (await service.getHistory('cached')).map((item) => item.content),
      ).toEqual(['replacement prompt', 'answer: replacement prompt']);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it.each(['request_user_input', 'request_user_input_async'])(
    'normalizes restored %s calls as question tools',
    (toolName) => {
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
          name: toolName,
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
    },
  );

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
