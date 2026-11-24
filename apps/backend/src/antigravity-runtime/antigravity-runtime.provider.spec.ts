import childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as paths from '../config/system-paths.js';
import * as schema from '../database/schema/index.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { TurnChangesService } from '../agent-runtime/turn-changes.service.js';
import type { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import { AntigravityRuntimeProvider } from './antigravity-runtime.provider.js';

jest.mock('../sessions/sessions.service.js', () => ({
  SessionsService: class SessionsService {},
}));
jest.mock('../settings/settings.service.js', () => ({
  SettingsService: class SettingsService {},
}));
jest.mock('../config/system-paths.js', () => ({
  findBinaryAsync: jest.fn(),
  buildAugmentedEnvAsync: jest.fn(),
}));

const request = { origin: 'desktop-chat', waitForCompletion: false } as const;
const mcpUrl = 'http://127.0.0.1:8765/api/mcp';
const existingToken = 'evx_fixture_session_7';

describe('interactive Antigravity through ACP stdio', () => {
  let db: Database.Database;
  let runs: AntigravityRuntimeProvider[];
  let spawn: jest.SpiedFunction<typeof childProcess.spawn>;
  let complete: jest.Mock;
  let renameTitle: jest.Mock;
  let profileHome: string;
  const sessionId = 7;

  const makeProvider = () => {
    const orm = drizzle(db, { schema });
    const sessions = {
      findOne: jest.fn(() =>
        Promise.resolve({
          id: sessionId,
          status: 'active',
          surface: 'session',
          activeAgentProvider: 'antigravity',
          worktreePath: __dirname,
          ...orm
            .select({
              name: schema.sessions.name,
              antigravitySessionId: schema.sessions.antigravitySessionId,
              antigravitySelection: schema.sessions.antigravitySelection,
            })
            .from(schema.sessions)
            .where(eq(schema.sessions.id, sessionId))
            .get(),
        }),
      ),
      assertSessionWorkspaceLinked: jest.fn().mockResolvedValue(undefined),
      markCompletionUnreviewed: complete,
      renameFromGeneratedTitle: renameTitle,
    };
    const runtime = new AntigravityRuntimeProvider(
      sessions as unknown as SessionsService,
      {
        getAgentProviderDefaults: () => ({
          model: null,
          reasoningEffort: null,
        }),
      } as unknown as SettingsService,
      {
        begin: jest.fn().mockResolvedValue(undefined),
        finish: jest.fn().mockResolvedValue(undefined),
        attachHistory: jest.fn(
          (_id: number, _provider: string, _native: string, items: unknown[]) =>
            Promise.resolve(items),
        ),
      } as unknown as TurnChangesService,
      new McpAgentTokenService(orm),
      orm,
      new SessionTitleService({} as TextAgentGenerationService),
    );
    runs.push(runtime);
    return runtime;
  };

  async function waitFor(
    runtime: AntigravityRuntimeProvider,
    predicate: (
      state: Awaited<ReturnType<AntigravityRuntimeProvider['getRuntimeState']>>,
    ) => boolean,
  ) {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const state = await runtime.getRuntimeState(sessionId);
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Antigravity did not reach the expected runtime state.');
  }

  beforeEach(async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      ELEVENEX_MCP_URL: mcpUrl,
    });
    runs = [];
    complete = jest.fn().mockResolvedValue(undefined);
    renameTitle = jest.fn().mockResolvedValue(undefined);
    profileHome = await mkdtemp(join(tmpdir(), 'elevenex-agy-test-home-'));
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, status TEXT, surface TEXT, active_agent_provider TEXT, mcp_agent_token TEXT, name TEXT NOT NULL);
      INSERT INTO sessions VALUES (7, 'active', 'session', 'antigravity', NULL, 'Named by user');`);
    db.exec(
      readFileSync(
        join(__dirname, '../../drizzle/0057_antigravity.sql'),
        'utf8',
      ),
    );
    jest.mocked(paths.findBinaryAsync).mockResolvedValue('official-agy');
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env,
      HOME: profileHome,
      USERPROFILE: profileHome,
      ELEVENEX_CODE_ACCESS: 'fixture-token',
      ELEVENEX_DESKTOP_SOCKET: '/tmp/fixture.sock',
    });
    const realSpawn = childProcess.spawn;
    spawn = jest.spyOn(childProcess, 'spawn');
    spawn.mockImplementation((_binary, args, options) =>
      realSpawn(
        process.execPath,
        [join(__dirname, 'test-fixtures/acp-agent.cjs'), ...args],
        options ?? {},
      ),
    );
  });

  afterEach(async () => {
    for (const runtime of runs) {
      await runtime.cleanupSession(sessionId);
      await runtime.onModuleDestroy();
    }
    jest.restoreAllMocks();
    db.close();
    await rm(profileHome, { recursive: true, force: true });
  });

  it('requires the desktop dispatch path before any process or native session is created', async () => {
    const provider = makeProvider();
    await expect(
      provider.submitPrompt(sessionId, 'agent delegation'),
    ).rejects.toThrow('directly');
    await expect(provider.resumePendingPrompts(sessionId)).rejects.toThrow(
      'directly',
    );
    expect(await provider.getHistory(sessionId)).toEqual([]);
    await provider.getRuntimeState(sessionId);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('retains background activity and accepts a permission-first wake before draining the queue', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(
      sessionId,
      'background wake',
      undefined,
      undefined,
      request,
    );
    const working = await waitFor(
      runtime,
      (state) => state.backgroundWork.length > 0,
    );
    expect(working.backgroundWork[0]).toMatchObject({
      id: 'task:command-1',
      detail: 'printf ready',
    });
    expect(working.canInterrupt).toBe(true);
    await runtime.submitPrompt(sessionId, 'queued', undefined, undefined, {
      ...request,
      queue: true,
    });
    const waiting = await waitFor(
      runtime,
      (state) => !!state.pendingPermissionRequest,
    );
    expect(waiting.pendingPrompts).toHaveLength(1);
    await runtime.approvePermission(
      sessionId,
      waiting.pendingPermissionRequest!.requestId,
    );
    await waitFor(
      runtime,
      (state) => state.runPhase === 'idle' && !state.pendingPrompts.length,
    );
    expect(await runtime.getHistory(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool_result',
          providerToolResult: { output: 'ready', exitCode: 0 },
        }),
        expect.objectContaining({
          kind: 'assistant',
          content: 'Background wake handled.',
        }),
        expect.objectContaining({
          kind: 'assistant',
          content: 'new, default-model: queued',
        }),
      ]),
    );
  });

  it('persists a native reply arriving after an idle transition without inserting a user message', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(
      sessionId,
      'detached reply',
      undefined,
      undefined,
      { origin: 'desktop-chat' },
    );
    expect((await runtime.getRuntimeState(sessionId)).runPhase).toBe('idle');
    const deadline = Date.now() + 4_000;
    let items = await runtime.getHistory(sessionId);
    while (
      !items.some(({ content }) => content === 'Late native reply') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      items = await runtime.getHistory(sessionId);
    }
    expect(items.map(({ content }) => content)).toEqual([
      'detached reply',
      'Late native reply',
    ]);
  });

  it('keeps a daemon visible while idle and saves its completion against the original command', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(sessionId, 'daemon wake', undefined, undefined, { origin: 'desktop-chat' });
    expect(await runtime.getRuntimeState(sessionId)).toMatchObject({
      runPhase: 'idle',
      backgroundWork: [{ id: 'task:command-1' }],
    });
    const waiting = await waitFor(runtime, (state) => !!state.pendingPermissionRequest);
    await runtime.approvePermission(sessionId, waiting.pendingPermissionRequest!.requestId);
    await waitFor(runtime, (state) => state.runPhase === 'idle');
    const history = await runtime.getHistory(sessionId);
    const command = history.find(({ kind }) => kind === 'tool_use');
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_result', toolUseId: command?.id, providerToolResult: { output: 'ready', exitCode: 0 } }),
      expect.objectContaining({ kind: 'assistant', content: 'Background wake handled.' }),
    ]));
  });

  it('stops a command after the prompt responds and leaves queued work paused', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(
      sessionId,
      'background stop',
      undefined,
      undefined,
      request,
    );
    await waitFor(runtime, (state) => state.backgroundWork.length > 0);
    await runtime.submitPrompt(sessionId, 'queued', undefined, undefined, {
      ...request,
      queue: true,
    });
    await runtime.interrupt(sessionId);
    const state = await runtime.getRuntimeState(sessionId);
    expect(state).toMatchObject({
      canInterrupt: false,
      backgroundWork: [],
      queuePaused: true,
    });
    expect(state.pendingPrompts).toHaveLength(1);
  });

  it('sends a queued message as a native steer and advertises the CLI commands', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(
      sessionId,
      'start steer',
      undefined,
      undefined,
      request,
    );
    await waitFor(runtime, (state) => state.canSteer && state.liveItems.some(({ content }) => content === 'Ready to steer.'));
    expect(await runtime.getAutocompleteItems(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ trigger: '/compact' }),
        expect.objectContaining({ trigger: '/goal', detail: 'Objective' }),
      ]),
    );
    await runtime.submitPrompt(sessionId, 'steer now', undefined, undefined, {
      ...request,
      queue: true,
    });
    const state = await runtime.getRuntimeState(sessionId);
    await expect(runtime.steerPendingPrompt(sessionId, state.pendingPrompts[0].id)).rejects.toThrow('directly');
    await runtime.steerPendingPrompt(sessionId, state.pendingPrompts[0].id, 'desktop-chat');
    await waitFor(runtime, (state) => state.runPhase === 'idle');
    expect(await runtime.getHistory(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'user', content: 'steer now' }),
        expect.objectContaining({
          kind: 'assistant',
          content: 'Steered without cancellation.',
        }),
      ]),
    );
  });

  it('requires an offered native choice even with Full access', async () => {
    const runtime = makeProvider();
    await runtime.setPermissionMode(
      sessionId,
      'bypassPermissions',
      'desktop-chat',
    );
    await runtime.submitPrompt(
      sessionId,
      'native choice',
      undefined,
      undefined,
      request,
    );
    const state = await waitFor(
      runtime,
      (state) => !!state.pendingUserInputRequest,
    );
    const { requestId, requestedSchema } = state.pendingUserInputRequest!;
    expect(requestedSchema).toMatchObject({
      properties: { choice: { enum: ['Grid', 'List'] } },
    });
    await expect(
      runtime.answerUserInput(sessionId, requestId, 'accept', {
        choice: 'Unknown',
      }),
    ).rejects.toThrow('offered');
    await runtime.answerUserInput(sessionId, requestId, 'accept', {
      choice: 'List',
    });
    await waitFor(runtime, (state) => state.runPhase === 'idle');
    expect(await runtime.getHistory(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'Selected List.' }),
      ]),
    );
  });

  it('serves bounded ACP text reads only to the active native session and workspace', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(sessionId, 'read client file', undefined, undefined, {
      origin: 'desktop-chat',
    });
    expect(await runtime.getHistory(sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Scoped file read completed.' }),
    ]));
  });

  it('replaces the edited suffix in a fresh native session and carries the kept context', async () => {
    const runtime = makeProvider();
    const send = (text: string) => runtime.submitPrompt(sessionId, text, undefined, undefined, {
      origin: 'desktop-chat',
    });
    await send('keep this');
    await send('remove this');
    const anchor = (await runtime.getHistory(sessionId)).find(({ content }) => content === 'remove this')?.sourceMessageId;
    expect(anchor).toMatch(/^\d+:/);
    await expect(runtime.rewindConversation(sessionId, anchor!)).rejects.toThrow('directly');
    await runtime.rewindConversation(sessionId, anchor!, 'desktop-chat');
    expect((await runtime.getHistory(sessionId)).map(({ content }) => content)).toEqual([
      'keep this', 'new, default-model: keep this',
    ]);
    const env = await paths.buildAugmentedEnvAsync(process.env);
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({ ...env, ACP_FIXTURE_NATIVE_ID: 'native-replacement' });
    await send('revised prompt');
    expect((await runtime.getRuntimeState(sessionId)).claudeSessionId).toBe('native-replacement');
    expect((await runtime.getHistory(sessionId)).map(({ content }) => content)).toEqual([
      'keep this', 'new, default-model: keep this', 'revised prompt', 'new, default-model: revised prompt',
    ]);
  });

  it('projects repeated native plan updates onto one checklist', async () => {
    const runtime = makeProvider();
    await runtime.submitPrompt(sessionId, 'update plan', undefined, undefined, { origin: 'desktop-chat' });
    const items = await runtime.getHistory(sessionId);
    expect(items.filter(({ kind }) => kind === 'tool_use')).toEqual([
      expect.objectContaining({
        toolKind: 'todo_write',
        toolInput: { todos: [{ content: 'Inspect project', status: 'completed' }] },
      }),
    ]);
  });

  it('embeds only previews supported by the native CLI and owned by the session', async () => {
    const root = join(profileHome, 'app-data');
    process.env.ELEVENEX_DATA_ROOT = root;
    const upload = async (owner: number, name: string, contents: string) => {
      const dir = join(root, 'chat-attachments', String(owner), '11111111-1111-4111-8111-111111111111');
      await mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await writeFile(path, contents);
      return `[${name}](<${path}>)`;
    };
    const links = await Promise.all([
      upload(sessionId, 'notes.txt', 'Owned text'),
      upload(sessionId, 'document.pdf', '%PDF-1.7'),
      upload(sessionId, 'audio.wav', 'Audio fixture'),
      upload(sessionId + 1, 'other.txt', 'Other session'),
      upload(sessionId, 'video.mp4', 'Video fallback'),
    ]);
    const runtime = makeProvider();
    await runtime.submitPrompt(sessionId, ['read attachments', ...links].join('\n'), undefined, undefined, {
      origin: 'desktop-chat',
    });
    expect(await runtime.getHistory(sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Native attachments matched.' }),
    ]));
  });

  it('only shows child records owned by the launching conversation and rejects redirects', async () => {
    const brain = join(profileHome, '.gemini', 'antigravity-cli', 'brain');
    const parent = join(brain, 'native-session', '.system_generated');
    const child = join(brain, 'child-1', '.system_generated');
    await mkdir(join(parent, 'subagents'), { recursive: true });
    await mkdir(join(child, 'messages'), { recursive: true });
    await mkdir(join(child, 'logs'), { recursive: true });
    await writeFile(
      join(parent, 'subagents', 'child-1.json'),
      JSON.stringify({ conversationId: 'child-1' }),
    );
    await writeFile(
      join(child, 'messages', 'launch.json'),
      JSON.stringify({
        sender: 'native-session',
        sourceMetadata: {
          tool: {
            conversationId: 'native-session',
            toolCall: {
              name: 'invoke_subagent',
              id: 'native-child-launch',
              argumentsJson: JSON.stringify({
                Role: 'Reviewer',
                Prompt: 'Review layout',
              }),
            },
          },
        },
      }),
    );
    const transcript = join(child, 'logs', 'transcript.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: 'Reviewed.',
      }) + '\n',
    );
    const runtime = makeProvider();
    await runtime.submitPrompt(
      sessionId,
      'subagent',
      undefined,
      undefined,
      request,
    );
    const state = await waitFor(runtime, (state) =>
      state.backgroundWork.some(({ kind }) => kind === 'subagent'),
    );
    const { agentId } = state.subagents[0];
    expect(
      (await runtime.getSubagentHistory(sessionId, agentId)).history.map(
        ({ content }) => content,
      ),
    ).toEqual(['Reviewer\n\nReview layout', 'Reviewed.']);
    await expect(
      runtime.getSubagentHistory(
        sessionId,
        agentId.replace(/-[a-f0-9]{24}$/, '-' + '0'.repeat(24)),
      ),
    ).rejects.toThrow('Unknown');
    const secret = join(profileHome, 'other.jsonl');
    await writeFile(
      secret,
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: 'Private',
      }),
    );
    await rm(transcript);
    await symlink(secret, transcript);
    expect(
      (await runtime.getSubagentHistory(sessionId, agentId)).history.map(
        ({ content }) => content,
      ),
    ).toEqual(['Reviewer\n\nReview layout']);
  });

  async function waitForTitle() {
    const deadline = Date.now() + 3_000;
    while (!renameTitle.mock.calls.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('generates a title once in a separate ACP session using the visible first prompt', async () => {
    db.exec("UPDATE sessions SET name = 'Session 1'");
    const provider = makeProvider();
    await provider.submitPrompt(sessionId, 'expanded prompt', 'visible prompt', undefined, request);
    await waitForTitle();
    expect(renameTitle).toHaveBeenCalledWith(sessionId, 'Generated Antigravity Title', {
      expectedName: 'Session 1',
      signal: expect.any(AbortSignal),
    });
    const helper = spawn.mock.calls.find(([, args]) => args.includes('--sandbox'));
    expect(helper).toBeDefined();
    expect(helper?.[2]).toMatchObject({ cwd: expect.stringContaining('elevenex-agy-title-') });
    expect(existsSync(String(helper?.[2]?.cwd))).toBe(false);
    await waitFor(provider, (state) => state.runPhase === 'idle');
    await provider.submitPrompt(sessionId, 'follow-up', undefined, undefined, request);
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(renameTitle).toHaveBeenCalledTimes(1);
  });

  it('uses the native title when global hooks prevent a separate title job', async () => {
    db.exec("UPDATE sessions SET name = 'Temporary session'");
    const config = join(profileHome, '.gemini', 'config');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
    const provider = makeProvider();
    await provider.submitPrompt(sessionId, 'expanded prompt', 'visible prompt', undefined, request);
    await waitForTitle();
    expect(renameTitle).toHaveBeenCalledWith(sessionId, 'Native Antigravity Title', {
      expectedName: 'Temporary session',
      signal: expect.any(AbortSignal),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels the title helper if its ACP session attempts tools', async () => {
    db.exec("UPDATE sessions SET name = 'Session 1'");
    const provider = makeProvider();
    await provider.submitPrompt(sessionId, 'tool attempt', undefined, undefined, request);
    await waitForTitle();
    expect(renameTitle).toHaveBeenCalledWith(sessionId, 'Native Antigravity Title', expect.any(Object));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(await provider.getHistory(sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'new, default-model: tool attempt' }),
    ]));
  });

  it('falls back to the first message when neither ACP session returns a usable title', async () => {
    db.exec("UPDATE sessions SET name = 'Session 1'");
    const provider = makeProvider();
    await provider.submitPrompt(sessionId, 'Review the session list layout', undefined, undefined, request);
    await waitForTitle();
    expect(renameTitle).toHaveBeenCalledWith(sessionId, 'Review the session list layout', expect.any(Object));
  });

  it('coalesces cold catalog reads and makes models selectable before the first turn', async () => {
    const provider = makeProvider();
    const [first, second] = await Promise.all([
      provider.getModelCatalog(),
      provider.getModelCatalog(),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      models: [
        { id: 'default-model', reasoningEfforts: ['low', 'high'] },
        { id: 'other-model' },
      ],
      providerDefaultModelId: 'default-model',
      providerDefaultReasoningEffort: 'high',
      unavailableReason: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT mcp_agent_token FROM sessions').get()).toEqual({
      mcp_agent_token: null,
    });
    expect(await provider.getModelCatalog()).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await provider.getHistory(sessionId)).toEqual([]);
    expect(await provider.getRuntimeState(sessionId)).toMatchObject({
      claudeSessionId: null,
      selectedModel: 'default-model',
    });
    await provider.setSelectedModel(sessionId, 'other-model');
    expect(spawn).toHaveBeenCalledTimes(1);
    await provider.submitPrompt(
      sessionId,
      'first message',
      undefined,
      undefined,
      request,
    );
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect(await provider.getHistory(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'new, other-model: first message' }),
      ]),
    );
    expect(await provider.getModelCatalog()).toEqual(first);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reports sign-in guidance and retries discovery immediately on refresh', async () => {
    const provider = makeProvider();
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env,
      ACP_FIXTURE_SIGNED_OUT: '1',
    });
    const unavailable = await provider.getModelCatalog();
    expect(unavailable.unavailableReason).toContain('agy acp --login');
    expect(unavailable.unavailableReason).not.toContain(
      'Secret login diagnostics',
    );
    expect(await provider.getModelCatalog()).toEqual(unavailable);
    expect(spawn).toHaveBeenCalledTimes(1);
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue(process.env);
    expect((await provider.getModelCatalog(true)).models).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { env: { ACP_FIXTURE_AUTO: '1' }, chosen: 'auto' },
    { env: { ACP_FIXTURE_LEGACY_MODES: '1' }, chosen: 'accept-edits' },
  ])('applies $chosen on the first turn and after resuming', async ({ env, chosen }) => {
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({ ...process.env, ...env });
    const provider = makeProvider();
    await provider.getModelCatalog();
    expect(await provider.getRuntimeState(sessionId)).toMatchObject({
      permissionMode: 'default',
      permissionModes: chosen === 'auto'
        ? ['default', 'accept-edits', 'auto', 'bypassPermissions']
        : ['default', 'accept-edits', 'bypassPermissions'],
      planMode: false,
      planAvailable: true,
    });
    await expect(provider.setPermissionMode(sessionId, 'bypassPermissions')).rejects.toThrow('desktop conversation');
    if (chosen !== 'auto')
      await expect(provider.setPermissionMode(sessionId, 'auto')).rejects.toThrow('unavailable');
    await Promise.all([
      provider.setSelectedModel(sessionId, 'other-model'),
      provider.setPermissionMode(sessionId, chosen),
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await provider.getRuntimeState(sessionId)).toMatchObject({
      selectedModel: 'other-model',
      permissionMode: chosen,
    });
    const reportMode = (runtime: AntigravityRuntimeProvider) => runtime.submitPrompt(
      sessionId, 'report mode', undefined, undefined, { ...request, waitForCompletion: true },
    );
    await reportMode(provider);
    await provider.cleanupSession(sessionId);
    const reconnected = makeProvider();
    await reportMode(reconnected);
    expect((await reconnected.getHistory(sessionId)).filter(item => item.kind === 'assistant')
      .map(item => item.content)).toEqual([`new in ${chosen}`, `resumed in ${chosen}`]);
    await reconnected.setPlanMode(sessionId, true);
    expect(await reconnected.getRuntimeState(sessionId)).toMatchObject({ planMode: true, permissionMode: chosen });
    await reportMode(reconnected);
    expect((await reconnected.getHistory(sessionId)).at(-1)?.content).toBe('resumed in plan');
    await reconnected.cleanupSession(sessionId);
    const restored = makeProvider();
    expect(await restored.getRuntimeState(sessionId)).toMatchObject({ planMode: true });
    await restored.setPlanMode(sessionId, false);
    await reportMode(restored);
    expect((await restored.getHistory(sessionId)).at(-1)?.content).toBe(`resumed in ${chosen}`);
  });

  it('reads a previously saved Plan permission as Plan mode and returns to Code', async () => {
    db.prepare('UPDATE sessions SET antigravity_selection = ?').run(JSON.stringify({ mode: 'plan' }));
    const provider = makeProvider();
    expect(await provider.getRuntimeState(sessionId)).toMatchObject({ planMode: true, permissionMode: 'default' });
    await provider.setPlanMode(sessionId, false);
    await provider.submitPrompt(sessionId, 'report mode', undefined, undefined, { ...request, waitForCompletion: true });
    expect((await provider.getHistory(sessionId)).at(-1)?.content).toBe('new in default');
  });

  it('uses one-time tool approvals in Full access and waits for human input and Plan approvals', async () => {
    const provider = makeProvider();
    await provider.getModelCatalog();
    await provider.setPermissionMode(sessionId, 'bypassPermissions', 'desktop-chat');
    await provider.submitPrompt(sessionId, 'review', undefined, undefined, request);
    const question = await waitFor(provider, state => !!state.pendingUserInputRequest);
    expect(question.permissionMode).toBe('bypassPermissions');
    expect(question.pendingPermissionRequest).toBeNull();
    expect(question.liveItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_result', content: 'allow' }),
    ]));
    await provider.answerUserInput(sessionId, question.pendingUserInputRequest!.requestId, 'accept', { reply: 'Continue.' });
    await waitFor(provider, state => state.runPhase === 'idle');
    await provider.setPlanMode(sessionId, true);
    await provider.submitPrompt(sessionId, 'review', undefined, undefined, request);
    const approval = await waitFor(provider, state => !!state.pendingPermissionRequest);
    expect(approval.planMode).toBe(true);
    await provider.interrupt(sessionId);
    await waitFor(provider, state => !state.canInterrupt);
  });

  it.each([
    { connectEnv: { ACP_FIXTURE_AUTO: '1', ACP_FIXTURE_IGNORE_MODE: '1' }, error: 'did not activate the selected mode' },
    { connectEnv: {}, error: 'selected Antigravity mode is unavailable' },
  ])('does not send a prompt when Antigravity reports that it $error', async ({ connectEnv, error }) => {
    const provider = makeProvider();
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env, ACP_FIXTURE_AUTO: '1',
    });
    await provider.getModelCatalog();
    await provider.setPermissionMode(sessionId, 'auto');
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({ ...process.env, ...connectEnv });
    await expect(provider.submitPrompt(sessionId, 'report mode', undefined, undefined, request))
      .rejects.toThrow(error);
    expect(await provider.getHistory(sessionId)).toEqual([]);
    await provider.setPermissionMode(sessionId, 'default');
    await provider.submitPrompt(sessionId, 'report mode', undefined, undefined, {
      ...request, waitForCompletion: true,
    });
    expect((await provider.getHistory(sessionId)).at(-1)?.content).toBe('resumed in default');
  });

  it('reports context, the account tier and model quota until that model completes again', async () => {
    const provider = makeProvider();
    await provider.submitPrompt(
      sessionId,
      'quota',
      undefined,
      undefined,
      request,
    );
    const failed = await waitFor(
      provider,
      (state) => state.runPhase === 'error',
    );
    expect(failed.lastError).toContain('used its Antigravity quota');
    expect(failed.lastError).not.toContain('RESOURCE_EXHAUSTED');
    expect(failed.contextUsage).toEqual({
      totalTokens: 0,
      maxTokens: 1048576,
      percentage: 0,
    });
    expect(failed.modelQuota).toMatchObject({
      provider: 'antigravity',
      tier: 'Antigravity Starter Quota',
      models: [
        {
          id: 'default-model',
          label: 'Default model',
          remainingPercentage: 0,
          exhausted: true,
        },
      ],
    });
    const resetIn = failed.modelQuota!.models[0].resetsAt! * 1000 - Date.now();
    expect(resetIn).toBeGreaterThan(2.4 * 3_600_000);
    expect(resetIn).toBeLessThanOrEqual(2.5 * 3_600_000 + 1_000);

    await provider.submitPrompt(
      sessionId,
      'again',
      undefined,
      undefined,
      request,
    );
    const completed = await waitFor(
      provider,
      (state) =>
        state.runPhase === 'idle' && state.contextUsage?.totalTokens === 12000,
    );
    expect(completed.contextUsage).toEqual({
      totalTokens: 12000,
      maxTokens: 1048576,
      percentage: 1.1,
    });
    expect(completed.modelQuota).toMatchObject({
      tier: 'Antigravity Starter Quota',
      models: [],
    });
  });

  it('streams and persists a turn, relays decisions, and resumes the same native conversation', async () => {
    db.prepare('UPDATE sessions SET mcp_agent_token = ?').run(existingToken);
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env,
      ELEVENEX_CODE_ACCESS: 'fixture-token',
      ELEVENEX_DESKTOP_SOCKET: '/tmp/fixture.sock',
      ACP_FIXTURE_EXPECT_MCP_TOKEN: existingToken,
    });
    const provider = makeProvider();
    await provider.submitPrompt(
      sessionId,
      'review',
      undefined,
      undefined,
      request,
    );
    const waiting = await waitFor(
      provider,
      (state) => !!state.pendingPermissionRequest,
    );
    const permission = waiting.pendingPermissionRequest!;
    expect(waiting.liveItems.map((item) => item.content)).toContain(
      'Ready to review.',
    );
    expect(permission.toolKind).toBe('read');
    expect(waiting.availableModels.map((model) => model.id)).toEqual([
      'default-model',
      'other-model',
    ]);
    expect(await provider.getHistory(sessionId)).toEqual([]);
    await expect(
      provider.approvePermission(sessionId, permission.requestId, true),
    ).rejects.toThrow('unavailable');
    await provider.approvePermission(sessionId, permission.requestId);
    const question = (
      await waitFor(provider, (state) => !!state.pendingUserInputRequest)
    ).pendingUserInputRequest!;
    await provider.answerUserInput(sessionId, question.requestId, 'accept', {
      reply: 'Continue.',
    });
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect(complete).toHaveBeenCalledWith(sessionId, 'completed');
    const original = await provider.getHistory(sessionId);
    expect(original.map((item) => [item.kind, item.content])).toEqual([
      ['user', 'review'],
      ['assistant', 'Ready to review.'],
      ['tool_use', undefined],
      ['tool_result', 'allow'],
      ['assistant', 'Continue.'],
    ]);
    expect(spawn).toHaveBeenCalledWith(
      'official-agy',
      ['acp', '--process-per-session'],
      expect.objectContaining({ cwd: __dirname }),
    );
    const launch = spawn.mock.calls[0]?.[2];
    expect(launch?.env).not.toHaveProperty('ELEVENEX_CODE_ACCESS');
    expect(launch?.env).not.toHaveProperty('ELEVENEX_DESKTOP_SOCKET');
    await provider.setSelectedModel(sessionId, 'other-model');
    await provider.cleanupSession(sessionId);

    const restarted = makeProvider();
    expect(await restarted.getHistory(sessionId)).toEqual(original);
    expect(spawn).toHaveBeenCalledTimes(1);
    await restarted.submitPrompt(
      sessionId,
      'continue the conversation',
      undefined,
      undefined,
      request,
    );
    await waitFor(restarted, (state) => state.runPhase === 'idle');
    expect((await restarted.getHistory(sessionId)).at(-1)?.content).toBe(
      'resumed, other-model: continue the conversation',
    );
  });

  it('keeps chat available when the CLI does not advertise HTTP MCP', async () => {
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env,
      ACP_FIXTURE_NO_HTTP_MCP: '1',
    });
    const provider = makeProvider();
    await provider.submitPrompt(
      sessionId,
      'hello',
      undefined,
      undefined,
      request,
    );
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect((await provider.getHistory(sessionId)).at(-1)?.content).toBe(
      'new, default-model: hello',
    );
    expect(db.prepare('SELECT mcp_agent_token FROM sessions').get()).toEqual({
      mcp_agent_token: null,
    });
  });

  it('cancels pending decisions and keeps user follow-ups paused until desktop resumes', async () => {
    const provider = makeProvider();
    await provider.submitPrompt(
      sessionId,
      'stop',
      undefined,
      undefined,
      request,
    );
    const running = await waitFor(
      provider,
      (state) => !!state.pendingPermissionRequest,
    );
    expect(running.canSteer).toBe(false);
    await provider.submitPrompt(sessionId, 'next', undefined, undefined, {
      ...request,
      queue: true,
    });
    await provider.interrupt(sessionId);
    const paused = await waitFor(
      provider,
      (state) => state.runPhase === 'idle',
    );
    expect(paused.pendingPermissionRequest).toBeNull();
    expect(paused.pendingPrompts.map((item) => item.prompt)).toEqual(['next']);
    expect(paused.queuePaused).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    await expect(provider.resumePendingPrompts(sessionId)).rejects.toThrow(
      'directly',
    );
    await provider.resumePendingPrompts(sessionId, request.origin);
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect(
      (await provider.getHistory(sessionId))
        .filter((item) => item.kind === 'user')
        .map((item) => item.content),
    ).toEqual(['stop', 'next']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('preserves an accepted prompt after the ACP process exits and requires another user message to reconnect', async () => {
    const provider = makeProvider();
    await provider.submitPrompt(
      sessionId,
      'exit',
      undefined,
      undefined,
      request,
    );
    await waitFor(
      provider,
      (state) => state.runPhase === 'error' && !state.canInterrupt,
    );
    expect(
      (await provider.getHistory(sessionId)).map((item) => item.content),
    ).toEqual(['exit']);
    expect(complete).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    await provider.submitPrompt(
      sessionId,
      'recover',
      undefined,
      undefined,
      request,
    );
    await waitFor(provider, (state) => state.runPhase === 'idle');
    expect(
      (await provider.getHistory(sessionId)).map((item) => item.content),
    ).toEqual(['exit', 'recover', 'resumed, default-model: recover']);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reports native login failures without recording or replaying the unsent prompt', async () => {
    const provider = makeProvider();
    jest
      .mocked(paths.buildAugmentedEnvAsync)
      .mockResolvedValue({ ...process.env, ACP_FIXTURE_SIGNED_OUT: '1' });
    await expect(
      provider.submitPrompt(
        sessionId,
        'never dispatched',
        undefined,
        undefined,
        request,
      ),
    ).rejects.toThrow('agy acp --login');
    const state = await waitFor(
      provider,
      (state) => state.runPhase === 'error' && !state.canInterrupt,
    );
    expect(state.lastError).not.toContain('Secret');
    expect(state.claudeSessionId).toBeNull();
    expect(await provider.getHistory(sessionId)).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
