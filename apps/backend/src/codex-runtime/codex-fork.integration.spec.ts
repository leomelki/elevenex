jest.mock('../session-title/session-title.service.js', () => ({
  SessionTitleService: class SessionTitleService {},
}));

import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodexAppServerClient } from './codex-app-server.js';
import { CodexHistoryService } from './codex-history.service.js';
import { CodexRuntimeService } from './codex-runtime.service.js';

// Opt in with an installed binary. Exercises local persistence only; no model,
// authentication, real user threads, or project files are used by the server.
const integration = process.env.ELEVENEX_CODEX_TEST_BIN
  ? describe
  : describe.skip;

integration('Codex fork persistence with the installed app-server', () => {
  it('retains earlier turns when forking, editing repeatedly, and reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elevenex-codex-fork-'));
    const previousHome = process.env.CODEX_HOME;
    const previousBinary = process.env.ELEVENEX_CODEX_BIN;
    process.env.CODEX_HOME = root;
    process.env.ELEVENEX_CODEX_BIN = process.env.ELEVENEX_CODEX_TEST_BIN;
    const clients: CodexAppServerClient[] = [];
    try {
      await writeFile(
        join(root, 'config.toml'),
        [
          'model_provider = "fixture"',
          '[model_providers.fixture]',
          'name = "Local fixture"',
          'base_url = "http://127.0.0.1:9/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          'supports_websockets = false',
        ].join('\n'),
      );
      const sessionsRoot = join(root, 'sessions');
      const directory = join(sessionsRoot, '2026', '10', '03');
      await mkdir(directory, { recursive: true });
      const sourceId = randomUUID();
      const records: unknown[] = [
        {
          type: 'session_meta',
          payload: {
            id: sourceId,
            timestamp: '2026-10-03T10:00:00Z',
            cwd: root,
            originator: 'codex_cli_rs',
            cli_version: '0.129.0',
            source: 'cli',
            model_provider: 'fixture',
          },
        },
      ];
      for (let turn = 1; turn <= 3; turn += 1) {
        records.push(
          {
            type: 'event_msg',
            payload: {
              type: 'task_started',
              turn_id: `turn-${turn}`,
              model_context_window: 400000,
              collaboration_mode_kind: 'default',
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: `prompt-${turn}` }],
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'user_message',
              message: `prompt-${turn}`,
              images: [],
              local_images: [],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: `answer-${turn}` }],
            },
          },
          {
            type: 'event_msg',
            payload: { type: 'agent_message', message: `answer-${turn}` },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: `turn-${turn}`,
              last_agent_message: `answer-${turn}`,
            },
          },
        );
      }
      const sourcePath = join(
        directory,
        `rollout-2026-10-03T10-00-00-${sourceId}.jsonl`,
      );
      const sourceContent =
        records
          .map((record) =>
            JSON.stringify({
              timestamp: '2026-10-03T10:00:00Z',
              ...(record as object),
            }),
          )
          .join('\n') + '\n';
      await writeFile(sourcePath, sourceContent);
      const history = new CodexHistoryService(sessionsRoot);
      const appServer = new CodexAppServerClient();
      clients.push(appServer);
      const parent = { id: 7, codexSessionId: sourceId };
      const child = { id: 8, codexSessionId: sourceId };
      const sessions = {
        findOne: async (id: number) => (id === 7 ? parent : child),
        updateCodexSessionId: async (id: number, threadId: string) => {
          (id === 7 ? parent : child).codexSessionId = threadId;
        },
      };
      const runtime = new CodexRuntimeService(
        sessions as never,
        {} as never,
        history,
        appServer,
        { updateRuntimeActivity: () => undefined } as never,
        {} as never,
        {
          getAgentProviderDefaults: () => ({
            model: null,
            reasoningEffort: null,
          }),
        } as never,
        {} as never,
        {} as never,
      );
      const sourceHistory = await history.getHistory(sourceId);
      const anchor = sourceHistory.find((item) => item.content === 'answer-2')!;
      const fork = await runtime.forkConversation({
        parentSessionId: 7,
        childSessionId: 8,
        anchorMessageId: anchor.transcriptMessageId!,
        anchorMessageKind: 'assistant',
        childSessionName: 'Fork',
      });
      child.codexSessionId = fork.providerSessionId!;
      expect(
        (await history.getHistory(child.codexSessionId)).map(
          (item) => item.content,
        ),
      ).toEqual(['prompt-1', 'answer-1', 'prompt-2', 'answer-2']);

      const edit = (await history.getHistory(child.codexSessionId)).find(
        (item) => item.content === 'prompt-2',
      )!;
      expect(
        (await runtime.rewindConversation(8, edit.sourceMessageId!)).map(
          (item) => item.content,
        ),
      ).toEqual(['prompt-1', 'answer-1']);
      expect(await readFile(sourcePath, 'utf8')).toBe(sourceContent);

      // A new app-server reads the persisted child, independently of the
      // in-memory thread that created it.
      const reopened = new CodexAppServerClient();
      clients.push(reopened);
      const resumed = await reopened.request<any>('thread/resume', {
        threadId: child.codexSessionId,
      });
      expect(resumed.thread.turns.map((turn: any) => turn.id)).toEqual([
        'turn-1',
      ]);
      expect(
        (await history.getHistory(child.codexSessionId)).map(
          (item) => item.content,
        ),
      ).toEqual(['prompt-1', 'answer-1']);

      const first = (await history.getHistory(child.codexSessionId)).find(
        (item) => item.kind === 'user',
      )!;
      expect(
        await runtime.rewindConversation(8, first.sourceMessageId!),
      ).toEqual([]);
      expect(await history.getHistory(child.codexSessionId)).toEqual([]);
    } finally {
      clients.forEach((client) => client.onModuleDestroy());
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousBinary === undefined) delete process.env.ELEVENEX_CODEX_BIN;
      else process.env.ELEVENEX_CODEX_BIN = previousBinary;
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }, 60_000);
});
