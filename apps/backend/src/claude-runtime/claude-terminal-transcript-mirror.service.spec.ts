import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import chokidar, { FSWatcher } from 'chokidar';
import { ClaudeTerminalTranscriptMirrorService } from './claude-terminal-transcript-mirror.service.js';
import type { ClaudeTranscriptRecord } from './claude-runtime.service.js';

jest.mock('chokidar');

const waitForDebounce = () =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, READ_DEBOUNCE_MS_FOR_TEST + 30),
  );
const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function recordToItem(record: ClaudeTranscriptRecord) {
  const message = record.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content)
    ? (message.content[0] as { text?: string })?.text
    : typeof message?.content === 'string'
      ? message.content
      : '';
  return {
    id: `${record.uuid}:user:0`,
    kind: record.type === 'assistant' ? 'assistant' : 'user',
    content,
    sourceMessageId: record.uuid as string,
    transcriptMessageId: record.uuid as string,
    timestamp:
      typeof record.timestamp === 'string'
        ? record.timestamp
        : '2026-01-01T00:00:00.000Z',
  };
}

describe('ClaudeTerminalTranscriptMirrorService', () => {
  let service: ClaudeTerminalTranscriptMirrorService;
  let runtime: {
    resolveTranscriptFile: jest.Mock;
    normalizeTranscriptRecordsForSession: jest.Mock;
  };
  let hooks: EventEmitter & { getActivity: jest.Mock };
  let watcher: jest.Mocked<FSWatcher>;
  let tempDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'elevenex-transcript-mirror-'));
    transcriptPath = join(tempDir, 'claude-session-1.jsonl');
    watcher = Object.assign(new EventEmitter(), {
      close: jest.fn().mockResolvedValue(undefined),
    }) as jest.Mocked<FSWatcher>;
    (chokidar.watch as jest.Mock).mockReturnValue(watcher);

    runtime = {
      resolveTranscriptFile: jest.fn().mockResolvedValue({
        sessionId: 7,
        worktreePath: '/tmp/project',
        claudeSessionId: 'claude-session-1',
        transcriptPath,
      }),
      normalizeTranscriptRecordsForSession: jest.fn(
        async (_sessionId: number, records: ClaudeTranscriptRecord[]) =>
          records.map(recordToItem),
      ),
    };
    hooks = Object.assign(new EventEmitter(), {
      getActivity: jest.fn(() => ({
        activityStatus: 'idle',
        actionKind: null,
        actionLabel: null,
      })),
    });
    service = new ClaudeTerminalTranscriptMirrorService(
      runtime as never,
      hooks as never,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await rm(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('sends an initial runtime snapshot and transcript history', async () => {
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }) + '\n',
    );
    const events: any[] = [];

    service.attachClient(7, (event) => events.push(event));
    await waitFor(() => events.length >= 2);

    expect(events.map((event) => event.type)).toEqual([
      'runtime_snapshot',
      'history_snapshot',
    ]);
    expect(events[0].payload.claudeSessionId).toBe('claude-session-1');
    expect(events[1].payload.history).toMatchObject([
      { id: 'user-1:user:0', content: 'Hello' },
    ]);
    expect(chokidar.watch).toHaveBeenCalledWith(
      transcriptPath,
      expect.objectContaining({ ignoreInitial: true, persistent: true }),
    );
  });

  it('switches to a new transcript when SessionStart provides a session id', async () => {
    runtime.resolveTranscriptFile.mockResolvedValueOnce({
      sessionId: 7,
      worktreePath: '/tmp/project',
      claudeSessionId: null,
      transcriptPath: null,
    });
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        uuid: 'user-2',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { content: [{ type: 'text', text: 'Resumed' }] },
      }) + '\n',
    );
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'history_snapshot'));
    runtime.resolveTranscriptFile.mockResolvedValue({
      sessionId: 7,
      worktreePath: '/tmp/project',
      claudeSessionId: 'claude-session-2',
      transcriptPath,
    });

    hooks.emit('hook-event', {
      sessionId: 7,
      payload: { hook_event_name: 'SessionStart', session_id: 'claude-session-2' },
    });
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === 'history_snapshot' &&
            event.payload.history?.[0]?.content === 'Resumed',
        ),
    );

    expect(events.some((event) => event.type === 'session_created')).toBe(true);
    expect(
      events.find(
        (event) =>
          event.type === 'history_snapshot' &&
          event.payload.history?.[0]?.content === 'Resumed',
      ),
    ).toMatchObject({
      type: 'history_snapshot',
      payload: { history: [{ content: 'Resumed' }] },
    });
  });

  it('handles appends, truncation, and partial trailing JSONL lines', async () => {
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: [{ type: 'text', text: 'First' }] },
      }) + '\n',
    );
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'history_snapshot'));

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: [{ type: 'text', text: 'First' }] },
      })}\n{"type"`,
    );
    watcher.emit('change');
    await waitForDebounce();
    expect(events[events.length - 1].payload.history).toMatchObject([{ content: 'First' }]);

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: [{ type: 'text', text: 'First' }] },
      })}\n{"type":"user","uuid":"user-2","timestamp":"2026-01-01T00:00:01.000Z","message":{"content":[{"type":"text","text":"Second"}]}}\n`,
    );
    watcher.emit('change');
    await waitForDebounce();
    expect(events[events.length - 1].payload.history).toMatchObject([
      { content: 'First' },
      { content: 'Second' },
    ]);

    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        uuid: 'user-3',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { content: [{ type: 'text', text: 'After truncate' }] },
      }) + '\n',
    );
    watcher.emit('change');
    await waitForDebounce();
    expect(events[events.length - 1].payload.history).toMatchObject([
      { content: 'After truncate' },
    ]);
  });

  it('derives runtime state from hook activity changes', async () => {
    await writeFile(transcriptPath, '');
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() => events.some((event) => event.type === 'history_snapshot'));

    hooks.emit('status-changed', {
      sessionId: 7,
      status: 'running',
      activityStatus: 'running',
    });

    expect(events[events.length - 1]).toMatchObject({
      type: 'run_state',
      payload: { runPhase: 'running', sessionState: 'running' },
    });
  });

  it('closes the watcher when the final client detaches', async () => {
    await writeFile(transcriptPath, '');
    const detach = service.attachClient(7, () => undefined);
    await waitFor(() => (chokidar.watch as jest.Mock).mock.calls.length > 0);

    detach();
    await waitFor(() => watcher.close.mock.calls.length > 0);
    await waitFor(() => service.getActiveSessionCount() === 0);

    expect(watcher.close).toHaveBeenCalled();
    expect(service.getActiveSessionCount()).toBe(0);
  });
});

const READ_DEBOUNCE_MS_FOR_TEST = 80;
