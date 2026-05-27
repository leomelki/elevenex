import { EventEmitter } from 'events';
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
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

function userRecord(
  uuid: string,
  text: string,
  timestamp: string,
  parentUuid?: string | null,
): ClaudeTranscriptRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    message: { content: [{ type: 'text', text }] },
  };
}

function assistantRecord(
  uuid: string,
  text: string,
  timestamp: string,
  parentUuid?: string | null,
): ClaudeTranscriptRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    message: { content: [{ type: 'text', text }] },
  };
}

function serializeRecords(records: ClaudeTranscriptRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

function activeBranch(
  records: ClaudeTranscriptRecord[],
): ClaudeTranscriptRecord[] {
  const byUuid = new Map(
    records
      .filter((record) => typeof record.uuid === 'string')
      .map((record) => [record.uuid as string, record]),
  );
  const leaf = [...records]
    .reverse()
    .find(
      (record) =>
        (record.type === 'user' || record.type === 'assistant') &&
        typeof record.uuid === 'string' &&
        record.isSidechain !== true,
    );
  if (!leaf || typeof leaf.uuid !== 'string') return records;

  const activeUuids = new Set<string>();
  let cursor: string | null = leaf.uuid;
  while (cursor && !activeUuids.has(cursor)) {
    const record = byUuid.get(cursor);
    if (!record) break;
    activeUuids.add(cursor);
    cursor =
      typeof record.parentUuid === 'string' && record.parentUuid
        ? record.parentUuid
        : null;
  }
  return records.filter(
    (record) => typeof record.uuid === 'string' && activeUuids.has(record.uuid),
  );
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
    await waitFor(() =>
      events.some((event) => event.type === 'history_snapshot'),
    );
    runtime.resolveTranscriptFile.mockResolvedValue({
      sessionId: 7,
      worktreePath: '/tmp/project',
      claudeSessionId: 'claude-session-2',
      transcriptPath,
    });

    hooks.emit('hook-event', {
      sessionId: 7,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'claude-session-2',
      },
    });
    await waitFor(() =>
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
    await waitFor(() =>
      events.some((event) => event.type === 'history_snapshot'),
    );

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
    expect(events[events.length - 1].payload.history).toMatchObject([
      { content: 'First' },
    ]);

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

  it('reloads the full transcript when a new branch is appended from an earlier parent', async () => {
    runtime.normalizeTranscriptRecordsForSession.mockImplementation(
      async (_sessionId: number, records: ClaudeTranscriptRecord[]) =>
        activeBranch(records).map(recordToItem),
    );
    const originalRecords = [
      userRecord('user-1', 'First', '2026-01-01T00:00:00.000Z', null),
      assistantRecord(
        'assistant-1',
        'Original answer',
        '2026-01-01T00:00:01.000Z',
        'user-1',
      ),
      userRecord(
        'user-2',
        'Stale prompt',
        '2026-01-01T00:00:02.000Z',
        'assistant-1',
      ),
      assistantRecord(
        'assistant-2',
        'Stale answer',
        '2026-01-01T00:00:03.000Z',
        'user-2',
      ),
    ];
    await writeFile(transcriptPath, serializeRecords(originalRecords));
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() =>
      events.some((event) => event.type === 'history_snapshot'),
    );

    await appendFile(
      transcriptPath,
      serializeRecords([
        userRecord(
          'user-3',
          'Restored prompt',
          '2026-01-01T00:00:04.000Z',
          'assistant-1',
        ),
      ]),
    );
    watcher.emit('change');

    await waitFor(() => {
      const last = events[events.length - 1];
      const history = last?.payload?.history;
      return (
        Array.isArray(history) &&
        history.some((item) => item.content === 'Restored prompt') &&
        !history.some((item) => item.content === 'Stale prompt')
      );
    });
    const lastHistory = events[events.length - 1].payload.history;
    expect(lastHistory).toMatchObject([
      { content: 'First' },
      { content: 'Original answer' },
      { content: 'Restored prompt' },
    ]);
    expect(
      runtime.normalizeTranscriptRecordsForSession,
    ).toHaveBeenLastCalledWith(7, [
      ...originalRecords,
      expect.objectContaining({ uuid: 'user-3' }),
    ]);
  });

  it('full reloads when the transcript is rewritten without shrinking', async () => {
    await writeFile(
      transcriptPath,
      serializeRecords([
        userRecord('user-1', 'First', '2026-01-01T00:00:00.000Z'),
        userRecord('user-2', 'Stale', '2026-01-01T00:00:01.000Z'),
      ]),
    );
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() =>
      events.some((event) => event.type === 'history_snapshot'),
    );

    await writeFile(
      transcriptPath,
      serializeRecords([
        userRecord('user-1', 'First', '2026-01-01T00:00:00.000Z'),
        userRecord('user-3', 'Restored', '2026-01-01T00:00:01.000Z'),
        userRecord(
          'user-4',
          'Continued with a longer replacement',
          '2026-01-01T00:00:02.000Z',
        ),
      ]),
    );
    watcher.emit('change');

    await waitFor(() => {
      const last = events[events.length - 1];
      const history = last?.payload?.history;
      return (
        Array.isArray(history) &&
        history.some((item) => item.content === 'Restored') &&
        !history.some((item) => item.content === 'Stale')
      );
    });
    expect(events[events.length - 1].payload.history).toMatchObject([
      { content: 'First' },
      { content: 'Restored' },
      { content: 'Continued with a longer replacement' },
    ]);
  });

  it('derives runtime state from hook activity changes', async () => {
    await writeFile(transcriptPath, '');
    const events: any[] = [];
    service.attachClient(7, (event) => events.push(event));
    await waitFor(() =>
      events.some((event) => event.type === 'history_snapshot'),
    );

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
