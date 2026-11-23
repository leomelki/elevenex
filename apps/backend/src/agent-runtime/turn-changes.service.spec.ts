import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnChangesPage } from '../desktop-workspace/desktop-chat-changes.js';
import * as schema from '../database/schema/index.js';
import { execFileAsync } from '../terminal/async-process.js';
import { TurnChangesService } from './turn-changes.service.js';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';

// The backend-wide watcher double is useful for gateway tests. These flows
// exercise actual writes and filesystem notifications through the real watcher.
jest.mock('chokidar', () => {
  const { createRequire } = process.getBuiltinModule('node:module')!;
  return createRequire(__filename)('chokidar');
});

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
      'CREATE TABLE sessions (id INTEGER PRIMARY KEY); INSERT INTO sessions VALUES (7), (8);',
    );
    sqlite.exec(
      await readFile(
        join(__dirname, '../../drizzle/0046_easy_mathemanic.sql'),
        'utf8',
      ),
    );
    sqlite.exec(
      await readFile(
        join(__dirname, '../../drizzle/0055_turn_change_summary.sql'),
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
    const compact = await service.attachHistory(
      7,
      'codex',
      'conversation-a',
      history,
      'summary',
    );
    expect(compact[1].turnChanges).toMatchObject({
      summaryOnly: true,
      files: 1,
      filesChanged: [{ hunks: [] }],
    });
    expect(await service.reviewDetails(7, 'codex', compact[1].id)).toEqual(
      marker?.turnChanges,
    );
    expect(
      await service.reviewDetails(8, 'codex', compact[1].id),
    ).toBeUndefined();
    expect(
      await service.reviewDetails(7, 'claude', compact[1].id),
    ).toBeUndefined();
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

  it('keeps successful patches attributable when another session and a failed shell edit the same checkout', async () => {
    const path = join(directory, 'shared.txt');
    const git = (...args: string[]) =>
      execFileAsync('git', args, { cwd: directory });
    await writeFile(path, 'original\n');
    await git('add', 'shared.txt');
    await git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'start',
    );
    const a = await service.begin(7, 'codex', directory);
    const b = await service.begin(8, 'claude', directory, 'claude-session');
    const prompt = item(new Date().toISOString());
    await writeFile(path, 'original\ncodex\n');
    const delta = [
      {
        path,
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1,2 @@\n original\n+codex\n',
      },
    ];
    service.recordCodexPatch(a, 'patch', 'native-turn', delta);
    service.recordCodexPatch(a, 'patch', 'native-turn', delta);

    const hook = {
      session_id: 'claude-session',
      tool_use_id: 'bash',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: { command: 'write files and exit 1' },
    };
    await service.claudeTool(8, { ...hook, hook_event_name: 'PreToolUse' });
    const code =
      'const fs = require("node:fs"); fs.appendFileSync("shared.txt", "claude\\n"); fs.writeFileSync("shell-only", "new\\n"); process.exit(1)';
    await expect(
      execFileAsync(process.execPath, ['-e', code], { cwd: directory }),
    ).rejects.toThrow();
    await service.claudeTool(8, {
      ...hook,
      hook_event_name: 'PostToolUseFailure',
    });
    await writeFile(join(directory, 'manual'), 'outside the command\n');
    const [first, second] = await Promise.all([
      service.finish(a, 'codex-session'),
      service.finish(b, 'claude-session'),
    ]);
    expect(first?.turnChanges?.evidence?.tools).toEqual([
      expect.objectContaining({
        toolId: 'patch',
        providerTurnId: 'native-turn',
        kind: 'provider',
      }),
    ]);
    expect(second?.turnChanges?.evidence?.tools).toEqual([
      expect.objectContaining({
        toolId: 'bash',
        kind: 'command',
        toolName: 'Bash (failed)',
      }),
    ]);
    const codex = [prompt, first!];
    const claude = [prompt, second!];
    expect(
      turnChangesPage(codex, prompt.id, 0).files.map((file) => file.path),
    ).toEqual(['manual', 'shared.txt', 'shell-only']);
    const net = turnChangesPage(codex, prompt.id, 0, 'shared.txt');
    expect(net.shared).toBe(true);
    expect(
      net.content?.lines
        .filter((line) => line.kind === 'add')
        .map((line) => line.text),
    ).toEqual(['codex', 'claude']);
    const provider = turnChangesPage(
      codex,
      prompt.id,
      0,
      'shared.txt',
      0,
      undefined,
      'provider',
    );
    expect(
      provider.content?.lines.filter((line) => line.kind === 'add'),
    ).toEqual([
      expect.objectContaining({
        text: 'codex',
        evidence: 'Apply patch · patch',
      }),
    ]);
    const shell = turnChangesPage(
      claude,
      prompt.id,
      0,
      'shell-only',
      0,
      undefined,
      'command',
    );
    expect(shell).toMatchObject({
      shared: true,
      total: 2,
      notice: expect.stringContaining('other writers'),
    });
    expect(
      shell.files.find((file) => file.path === 'shell-only'),
    ).toMatchObject({ status: 'A', add: 1 });
    expect(shell.files.some((file) => file.path === 'manual')).toBe(false);
    expect(shell.content?.lines[0]).toMatchObject({
      text: 'new',
      evidence: 'Bash (failed) · bash',
    });
    expect(
      turnChangesPage(claude, prompt.id, 0, undefined, 0, undefined, 'provider')
        .total,
    ).toBe(0);
  });

  it('deduplicates Claude native and filesystem command evidence while retaining locally observed paths', async () => {
    const capture = await service.begin(7, 'claude', directory);
    const hook = {
      session_id: 'thread',
      tool_use_id: 'shell',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: {},
    };
    await service.claudeTool(7, { ...hook, hook_event_name: 'PreToolUse' });
    await Promise.all([
      writeFile(join(directory, 'shell-file'), 'from bash\n'),
      writeFile(join(directory, 'extra-file'), 'also observed\n'),
    ]);
    const tool_response = {
      bashEditDiff: {
        changedFiles: [join(directory, 'shell-file')],
        files: [
          {
            filePath: join(directory, 'shell-file'),
            created: true,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: ['+from bash'],
              },
            ],
          },
        ],
      },
    };
    await service.claudeTool(7, {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_response,
    });
    const result = await service.finish(capture, 'thread');
    const files = result?.turnChanges?.evidence?.tools[0].files;
    expect(files?.map((file) => [file.path, file.additions])).toEqual([
      ['extra-file', 1],
      ['shell-file', 1],
    ]);
    expect(result?.turnChanges?.files).toBe(2);
  });

  it('uses command-local versions for sequential commands and marks overlapping windows as shared', async () => {
    const capture = await service.begin(7, 'pi', directory);
    const path = join(directory, 'versions');
    await service.startCommand(capture, 'first', 'Bash');
    await writeFile(path, 'first\n');
    await service.endCommand(capture, 'first');

    await service.startCommand(capture, 'second', 'Bash');
    await service.startCommand(capture, 'overlapping', 'Bash');
    await writeFile(path, 'second\n');
    await Promise.all([
      service.endCommand(capture, 'second'),
      service.endCommand(capture, 'overlapping'),
    ]);

    await service.startCommand(capture, 'net-zero', 'Bash');
    await writeFile(path, 'intermediate\n');
    await writeFile(path, 'second\n');
    await service.endCommand(capture, 'net-zero');
    const result = await service.finish(capture, 'pi-thread');
    const tools = result?.turnChanges?.evidence?.tools;
    expect(tools?.map((tool) => tool.toolId).sort()).toEqual([
      'first',
      'overlapping',
      'second',
    ]);
    expect(
      tools?.find((tool) => tool.toolId === 'first')?.files[0],
    ).toMatchObject({
      status: 'created',
      additions: 1,
      deletions: 0,
      attribution: 'observed',
    });
    for (const tool of tools?.filter((tool) => tool.toolId !== 'first') ?? [])
      expect(tool.files[0]).toMatchObject({
        status: 'modified',
        additions: 1,
        deletions: 1,
        attribution: 'shared',
        hunks: [{ patch: expect.stringContaining('-first\n+second') }],
      });
    expect(result?.turnChanges?.filesChanged).toMatchObject([
      { path: 'versions', status: 'created', additions: 1, deletions: 0 },
    ]);
    const prompt = item(capture.startedAt);
    const review = turnChangesPage(
      [prompt, result!],
      prompt.id,
      0,
      'versions',
      0,
      undefined,
      'command',
    );
    expect(review.files[0]).toMatchObject({ add: 2, del: 1 });
    expect(
      review.content?.lines
        .filter((line) => line.kind === 'add')
        .map((line) => line.text),
    ).toEqual(['first', 'second']);
    const secondLine = review.content?.lines.find(
      (line) => line.text === 'second',
    );
    expect(secondLine?.evidence).toContain('· second');
    expect(secondLine?.evidence).toContain('· overlapping');
  });

  it('retains successful tool history when the net change is zero and ignores late or unmatched receipts', async () => {
    const capture = await service.begin(7, 'claude', directory, 'thread');
    const prompt = item(new Date().toISOString());
    const path = join(directory, 'temporary');
    const hook = {
      session_id: 'thread',
      tool_use_id: 'write',
      tool_name: 'Write',
      cwd: directory,
      tool_input: {},
    };
    const result = {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_response: { type: 'create', filePath: path, content: 'temporary\n' },
    };
    await service.claudeTool(7, { ...result, tool_use_id: 'never-started' });
    await service.claudeTool(7, { ...hook, hook_event_name: 'PreToolUse' });
    await writeFile(path, 'temporary\n');
    await service.claudeTool(7, { ...result, session_id: 'another-thread' });
    await service.claudeTool(7, result);
    await rm(path);
    const marker = await service.finish(capture, 'thread');
    expect(marker?.turnChanges?.files).toBe(0);
    const net = turnChangesPage([prompt, marker!], prompt.id, 0);
    expect(net).toMatchObject({ total: 0, sources: ['provider'] });
    const provider = turnChangesPage(
      [prompt, marker!],
      prompt.id,
      0,
      'temporary',
      0,
      undefined,
      'provider',
    );
    expect(provider).toMatchObject({
      total: 1,
      files: [{ add: 1, status: 'A' }],
      content: { lines: [{ text: 'temporary' }] },
    });
    expect(() =>
      turnChangesPage(
        [prompt, marker!],
        prompt.id,
        0,
        undefined,
        0,
        net.revision,
        'provider',
      ),
    ).toThrow('updated');
  });

  it('reconciles an interrupted tool without inventing a command receipt and supports sparse providers', async () => {
    const interrupt = await service.begin(7, 'pi', directory);
    await service.startCommand(interrupt, 'open-command', 'Bash');
    await writeFile(join(directory, 'partial'), 'left on disk\n');
    const stopped = await service.finish(interrupt, 'pi-session');
    expect(stopped?.turnChanges).toMatchObject({
      files: 1,
      evidence: { tools: [], partial: true },
      filesChanged: [{ path: 'partial', status: 'created' }],
    });
    const sparse = await service.begin(8, 'opencode', directory);
    await writeFile(join(directory, 'partial'), 'later\n');
    expect(
      (await service.finish(sparse, 'opencode-session'))?.turnChanges,
    ).toMatchObject({
      files: 1,
      evidence: { tools: [] },
      filesChanged: [
        { path: 'partial', status: 'modified', additions: 1, deletions: 1 },
      ],
    });
  });

  it('takes targeted Claude preimages when the editor receipt has no patch', async () => {
    const capture = await service.begin(7, 'claude', directory, 'thread');
    const file = join(directory, 'edited');
    await writeFile(file, 'manual preimage\n');
    const hook = {
      session_id: 'thread',
      tool_use_id: 'edit',
      tool_name: 'Edit',
      cwd: directory,
      tool_input: { file_path: file },
    };
    await service.claudeTool(7, { ...hook, hook_event_name: 'PreToolUse' });
    await writeFile(file, 'editor result\n');
    await writeFile(join(directory, 'unrelated'), 'external edit\n');
    await service.claudeTool(7, {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_response: {},
    });
    const result = await service.finish(capture, 'thread');
    const tools = result?.turnChanges?.evidence?.tools;
    expect(tools).toMatchObject([
      {
        kind: 'command',
        files: [
          {
            path: 'edited',
            status: 'modified',
            attribution: 'observed',
            hunks: [
              {
                patch: expect.stringContaining(
                  '-manual preimage\n+editor result',
                ),
              },
            ],
          },
        ],
      },
    ]);
    expect(result?.turnChanges?.files).toBe(2);
  });

  it('uses Pi native edit patches and keeps a later same-path edit as observation', async () => {
    const file = join(directory, 'pi-file');
    await writeFile(file, 'before\n');
    const capture = await service.begin(7, 'pi', directory);
    await service.startEditor(capture, 'first', 'Edit', { path: 'pi-file' });
    await writeFile(file, 'pi\n');
    service.piToolEnd(
      capture,
      'first',
      { details: { patch: '@@ -1 +1 @@\n-before\n+pi' } },
      false,
    );
    await service.endCommand(capture, 'first');

    await service.startEditor(capture, 'second', 'Edit', { path: 'pi-file' });
    await writeFile(file, 'pi twice\nmanual\n');
    service.piToolEnd(
      capture,
      'second',
      { details: { patch: '@@ -1 +1 @@\n-pi\n+pi twice' } },
      false,
    );
    await service.endCommand(capture, 'second');
    const result = await service.finish(capture, 'pi-thread');
    expect(result?.turnChanges?.evidence?.tools).toMatchObject([
      {
        kind: 'provider',
        toolId: 'first',
        files: [{ path: 'pi-file', additions: 1 }],
      },
      {
        kind: 'provider',
        toolId: 'second',
        files: [{ path: 'pi-file', additions: 1 }],
      },
      {
        kind: 'command',
        toolId: 'second',
        files: [{ path: 'pi-file', additions: 2 }],
      },
    ]);
  });

  it('keeps conflicting native and local shell observations under one path', async () => {
    const capture = await service.begin(7, 'claude', directory, 'thread');
    const hook = {
      session_id: 'thread',
      tool_use_id: 'shell',
      tool_name: 'Bash',
      cwd: directory,
      tool_input: {},
    };
    await service.claudeTool(7, { ...hook, hook_event_name: 'PreToolUse' });
    const path = join(directory, 'shared');
    await writeFile(path, 'native\nlocal\n');
    await service.claudeTool(7, {
      ...hook,
      hook_event_name: 'PostToolUse',
      tool_response: {
        bashEditDiff: {
          files: [
            {
              filePath: path,
              created: true,
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  lines: ['+native'],
                },
              ],
            },
          ],
        },
      },
    });
    const marker = await service.finish(capture, 'thread');
    const prompt = item(capture.startedAt);
    const review = turnChangesPage(
      [prompt, marker!],
      prompt.id,
      0,
      'shared',
      0,
      undefined,
      'command',
    );
    expect(review).toMatchObject({ total: 1, shared: true });
    expect(review.content?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'native',
          evidence: expect.stringContaining('Provider observation'),
        }),
        expect.objectContaining({
          text: 'local',
          evidence: expect.stringContaining('Local observation'),
        }),
      ]),
    );
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
