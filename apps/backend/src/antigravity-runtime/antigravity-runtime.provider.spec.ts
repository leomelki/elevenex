import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as paths from '../config/system-paths.js';
import * as schema from '../database/schema/index.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { TurnChangesService } from '../agent-runtime/turn-changes.service.js';
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

describe('interactive Antigravity through ACP stdio', () => {
  let db: Database.Database;
  let runs: AntigravityRuntimeProvider[];
  let spawn: jest.SpiedFunction<typeof childProcess.spawn>;
  let complete: jest.Mock;
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
    };
    const runtime = new AntigravityRuntimeProvider(
      sessions as unknown as SessionsService,
      {
        getAgentProviderDefaults: () => ({
          model: null,
          reasoningEffort: null,
        }),
      } as SettingsService,
      {
        begin: jest.fn().mockResolvedValue(undefined),
        finish: jest.fn().mockResolvedValue(undefined),
        attachHistory: jest.fn(
          (_id: number, _provider: string, _native: string, items: unknown[]) =>
            Promise.resolve(items),
        ),
      } as unknown as TurnChangesService,
      orm,
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

  beforeEach(() => {
    runs = [];
    complete = jest.fn().mockResolvedValue(undefined);
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY, status TEXT, surface TEXT, active_agent_provider TEXT);
      INSERT INTO sessions VALUES (7, 'active', 'session', 'antigravity');`);
    db.exec(
      readFileSync(
        join(__dirname, '../../drizzle/0056_antigravity.sql'),
        'utf8',
      ),
    );
    jest.mocked(paths.findBinaryAsync).mockResolvedValue('official-agy');
    jest.mocked(paths.buildAugmentedEnvAsync).mockResolvedValue({
      ...process.env,
      ELEVENEX_CODE_ACCESS: 'fixture-token',
      ELEVENEX_DESKTOP_SOCKET: '/tmp/fixture.sock',
    });
    const realSpawn = childProcess.spawn;
    spawn = jest.spyOn(childProcess, 'spawn');
    spawn.mockImplementation((_binary, _args, options) =>
      realSpawn(
        process.execPath,
        [join(__dirname, 'test-fixtures/acp-agent.cjs')],
        options ?? {},
      ),
    );
  });

  afterEach(async () => {
    for (const runtime of runs) {
      await runtime.cleanupSession(sessionId);
      await runtime.onModuleDestroy();
    }
    spawn.mockRestore();
    db.close();
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
        ? ['default', 'accept-edits', 'plan', 'auto']
        : ['default', 'accept-edits', 'plan'],
    });
    await expect(provider.setPermissionMode(sessionId, 'bypassPermissions')).rejects.toThrow('unavailable');
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
    await reconnected.setPermissionMode(sessionId, 'plan');
    await reportMode(reconnected);
    expect((await reconnected.getHistory(sessionId)).at(-1)?.content).toBe('resumed in plan');
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
      ['acp'],
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
