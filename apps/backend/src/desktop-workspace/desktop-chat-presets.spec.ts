import { EventEmitter } from 'node:events';
import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { chatPresets, executePresetAction } from './desktop-chat-presets.js';

function setup() {
  const preset = {
    id: 'deep',
    name: 'Deep work',
    provider: 'claude',
    model: 'model',
    reasoningEffort: 'high',
    fastMode: true,
  };
  const runtime = Object.assign(new EventEmitter(), {
    info: { id: 'codex' },
    getRuntimeState: jest.fn(async () => ({
      selectedModel: 'model',
      availableModels: [
        {
          id: 'model',
          reasoningEfforts: ['low', 'high'],
          supportsFastMode: true,
        },
      ],
    })),
    setSelectedModel: jest.fn(async () => undefined),
    setReasoningEffort: jest.fn(async () => undefined),
    setFastMode: jest.fn(async () => undefined),
  });
  const registry = {
    getProvider: jest.fn(() => runtime),
    listModelCatalogs: jest.fn(async () => [{ displayName: 'Claude Code', providerDefaultModelId: 'model', reasoningEfforts: ['low', 'high'],
      models: [{ id: 'model', displayName: 'Model', reasoningEfforts: ['low', 'high'], supportsFastMode: true }] }]),
    listProviders: () => [
      { id: 'codex', displayName: 'Codex' },
      { id: 'claude', displayName: 'Claude Code' },
    ],
  };
  const settings = {
    getAgentModelPresets: () => [preset],
    getAgentProviderDefaults: () => ({ model: 'model', reasoningEffort: 'high', fastMode: false }),
    addAgentModelPreset: jest.fn(),
    assertPresetDefaultRevision: jest.fn(),
    setAgentPresetDefault: jest.fn(),
    restoreAgentPresetDefault: jest.fn(),
  };
  const sessions = {
    assertSessionWorkspaceLinked: jest.fn(),
    hasStartedAgentRuntime: jest.fn(() => false),
    updateActiveAgentProvider: jest.fn(),
  };
  const session = {
    activeAgentProvider: 'codex',
    status: 'active',
    workspaceArchivedAt: null,
  } as Awaited<ReturnType<SessionsService['findOne']>>;
  const run = (action: Record<string, unknown>) =>
    executePresetAction(
      sessions as unknown as SessionsService,
      registry as unknown as AgentRuntimeRegistryService,
      settings as unknown as SettingsService,
      2,
      session,
      action,
    );
  return { preset, runtime, registry, settings, sessions, session, run };
}
describe('starting presets', () => {
  it('validates and applies the complete saved mix, including a harness change', async () => {
    const { run, runtime, sessions } = setup();
    await run({ type: 'preset', id: 'deep', expectedProvider: 'codex' });
    expect(sessions.updateActiveAgentProvider).toHaveBeenCalledWith(
      2,
      'claude',
    );
    expect(runtime.setSelectedModel).toHaveBeenCalledWith(2, 'model');
    expect(runtime.setReasoningEffort).toHaveBeenCalledWith(2, 'high');
    expect(runtime.setFastMode).toHaveBeenCalledWith(2, true);
    expect(runtime.getRuntimeState).toHaveBeenCalledWith(2, {
      initialize: false,
    });
  });
  it('rejects stale, started, archived and unsupported mixes before any write', async () => {
    const { run, preset, runtime, sessions, session, settings } = setup();
    await expect(
      run({ type: 'preset', id: 'deep', expectedProvider: 'pi' }),
    ).rejects.toThrow('changed');
    sessions.hasStartedAgentRuntime.mockReturnValue(true);
    await expect(
      run({ type: 'preset', id: 'deep', expectedProvider: 'codex' }),
    ).rejects.toThrow('before the first');
    sessions.hasStartedAgentRuntime.mockReturnValue(false);
    session.status = 'archived';
    await expect(
      run({ type: 'preset', id: 'deep', expectedProvider: 'codex' }),
    ).rejects.toThrow('before the first');
    session.status = 'active';
    preset.reasoningEffort = 'invented';
    await expect(
      run({ type: 'preset', id: 'deep', expectedProvider: 'codex' }),
    ).rejects.toThrow('thinking level');
    expect(runtime.setSelectedModel).not.toHaveBeenCalled();
    expect(sessions.updateActiveAgentProvider).not.toHaveBeenCalled();
    expect(settings.addAgentModelPreset).not.toHaveBeenCalled();
  });
  it('saves only validated configurations and reports a partial provider failure for reconciliation', async () => {
    const { run, settings, runtime } = setup();
    const action = {
      type: 'save-preset',
      id: 'new',
      name: ' Quick ',
      expectedProvider: 'codex',
      model: 'model',
      reasoning: 'low',
      fast: true,
    };
    await expect(run({ ...action, fast: 'true' })).rejects.toThrow(
      'Invalid preset',
    );
    expect(settings.addAgentModelPreset).not.toHaveBeenCalled();
    runtime.setReasoningEffort.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(run(action)).rejects.toThrow('could not be fully applied');
    expect(settings.addAgentModelPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Quick',
        model: 'model',
        reasoningEffort: 'low',
        fastMode: true,
      }),
    );
    expect(runtime.setSelectedModel).toHaveBeenCalledTimes(1);
  });
  it('checks the default revision and model support before writing a default', async () => {
    const { run, settings, preset } = setup();
    preset.reasoningEffort = 'unavailable';
    await expect(
      run({
        type: 'preset-default',
        id: 'deep',
        expectedProvider: 'codex',
        expectedRevision: 'revision',
      }),
    ).rejects.toThrow('thinking');
    expect(settings.setAgentPresetDefault).not.toHaveBeenCalled();
    preset.reasoningEffort = 'high';
    await run({
      type: 'preset-default',
      id: 'deep',
      expectedProvider: 'codex',
      expectedRevision: 'revision',
    });
    expect(settings.setAgentPresetDefault).toHaveBeenCalledWith(
      'deep',
      'revision',
    );
  });
  it('restores only future defaults after starting, without changing the current runtime', async () => {
    const { run, sessions, settings, runtime } = setup();
    sessions.hasStartedAgentRuntime.mockReturnValue(true);
    await run({
      type: 'preset-default-restore',
      provider: 'claude',
      defaultIds: ['deep'],
      expectedRevision: 'revision',
    });
    expect(settings.restoreAgentPresetDefault).toHaveBeenCalledWith(
      { provider: 'claude', defaultIds: ['deep'] },
      'revision',
    );
    expect(runtime.setSelectedModel).not.toHaveBeenCalled();
  });
  it('saves a chosen harness while checking the original conversation harness', async () => {
    const { run, settings, sessions } = setup();
    await run({ type: 'save-preset', id: 'new', name: 'Claude review', expectedProvider: 'codex', provider: 'claude', model: 'model', reasoning: 'high', fast: false });
    expect(settings.addAgentModelPreset).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude', name: 'Claude review' }));
    expect(sessions.updateActiveAgentProvider).toHaveBeenCalledWith(2, 'claude');
    await expect(run({ type: 'save-preset', id: 'stale', name: 'Stale', expectedProvider: 'claude', provider: 'codex', model: 'model', reasoning: 'high', fast: false })).rejects.toThrow('changed');
  });
  it('omits presets for unregistered harnesses', () => {
    const { preset, settings, registry } = setup();
    preset.provider = 'removed';
    expect(
      chatPresets(
        settings as unknown as SettingsService,
        registry as unknown as AgentRuntimeRegistryService,
      ),
    ).toEqual([]);
  });
});
