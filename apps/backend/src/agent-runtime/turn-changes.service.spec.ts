import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import * as schema from '../database/schema/index.js';
import { execFileAsync } from '../terminal/async-process.js';
import { TurnChangesService } from './turn-changes.service.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

describe('TurnChangesService persistence and lifecycle', () => {
  let sqlite: Database.Database;
  let service: TurnChangesService;
  let directory: string;
  const item = (timestamp: string): ClaudeTranscriptItem => ({
    id: 'assistant',
    kind: 'assistant',
    content: 'Done',
    timestamp,
  });

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(
      'CREATE TABLE sessions (id INTEGER PRIMARY KEY); INSERT INTO sessions VALUES (7);',
    );
    sqlite.exec(
      await readFile(
        join(__dirname, '../../drizzle/0046_easy_mathemanic.sql'),
        'utf8',
      ),
    );
    service = new TurnChangesService(drizzle(sqlite, { schema }));
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'elevenex-turn-changes-')),
    );
    await execFileAsync('git', ['init', '-q'], { cwd: directory });
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('saves captures and restores them after a backend restart, scoped to the provider conversation', async () => {
    const capture = await service.begin(7, 'codex', directory);
    const authoredAt = new Date().toISOString();
    await writeFile(join(directory, 'from-python.ts'), 'new\n');
    const marker = await service.finish(capture, 'conversation-a');
    expect(marker?.turnChanges?.files).toBe(1);
    await service.onModuleDestroy();
    service = new TurnChangesService(drizzle(sqlite, { schema }));
    const history = [item(authoredAt)];
    expect(
      await service.attachHistory(7, 'codex', 'conversation-a', history),
    ).toEqual([history[0], marker]);
    expect(
      await service.attachHistory(7, 'codex', 'conversation-b', history),
    ).toEqual(history);
    expect(
      await service.attachHistory(7, 'claude', 'conversation-a', history),
    ).toEqual(history);
  });

  it('does not restore observations for a rewound-away turn or persist a cancelled session', async () => {
    const capture = await service.begin(7, 'codex', directory);
    await writeFile(join(directory, 'created'), 'new\n');
    await service.finish(capture, 'conversation');
    const oldHistory = [item('2020-01-01T00:00:00.000Z')];
    expect(
      await service.attachHistory(7, 'codex', 'conversation', oldHistory),
    ).toEqual(oldHistory);
    const cancelled = await service.begin(7, 'codex', directory);
    service.cancelSession(7);
    expect(await service.finish(cancelled, 'conversation')).toBeUndefined();
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM turn_changes').get(),
    ).toEqual({ n: 1 });
  });

  it('reports unavailable capture explicitly rather than suppressing existing tool changes', async () => {
    const capture = await service.begin(
      7,
      'claude',
      join(directory, 'missing'),
    );
    const marker = await service.finish(capture, 'conversation');
    expect(marker?.turnChanges?.capture).toMatchObject({ complete: false });
    expect(marker?.turnChanges?.capture?.message).toMatch(/could not/);
  });
});
