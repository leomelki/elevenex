import type { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { chatCatalog } from './desktop-chat-catalog.js';

describe('preset harness catalog', () => {
  it('bounds provider models and uses supported saved defaults without allocating a runtime', async () => {
    const provider = {
      setReasoningEffort: jest.fn(),
      setFastMode: jest.fn(),
      getRuntimeState: jest.fn(),
    };
    const registry = {
      getProvider: jest.fn(() => provider),
      listModelCatalogs: jest.fn(async () => [
        {
          displayName: 'Claude Code',
          providerDefaultModelId: 'm0',
          reasoningEfforts: ['low', 'high'],
          models: Array.from({ length: 120 }, (_, i) => ({
            id: 'm' + i,
            displayName: 'Model ' + i,
            supportsFastMode: i === 1,
          })),
        },
      ]),
    };
    const settings = {
      getAgentProviderDefaults: () => ({
        model: 'm1',
        reasoningEffort: 'high',
        fastMode: true,
      }),
    };
    const catalog = await chatCatalog(
      registry as unknown as AgentRuntimeRegistryService,
      settings as unknown as SettingsService,
      'claude',
    );
    expect(catalog.models).toHaveLength(100);
    expect(catalog).toMatchObject({
      model: 'm1',
      reasoning: 'high',
      fast: true,
    });
    expect(registry.listModelCatalogs).toHaveBeenCalledWith(false, 'claude');
    expect(provider.getRuntimeState).not.toHaveBeenCalled();
    expect(provider.setReasoningEffort).not.toHaveBeenCalled();
  });
  it('refreshes the provider-owned catalog on explicit retry', async () => {
    const registry = {
      getProvider: () => ({}),
      listModelCatalogs: jest.fn(),
      refreshModelCatalogs: jest.fn(async () => [
        {
          displayName: 'Claude Code',
          models: [],
          reasoningEfforts: [],
          supportsModelSelection: false,
        },
      ]),
    };
    const settings = {
      getAgentProviderDefaults: () => ({ model: null, reasoningEffort: null }),
    };
    await chatCatalog(
      registry as unknown as AgentRuntimeRegistryService,
      settings as unknown as SettingsService,
      'claude',
      true,
    );
    expect(registry.refreshModelCatalogs).toHaveBeenCalledWith('claude');
    expect(registry.listModelCatalogs).not.toHaveBeenCalled();
  });
  it('exposes a retryable, safe failure when a harness cannot report models', async () => {
    const registry = {
      getProvider: () => ({}),
      listModelCatalogs: async () => [
        {
          displayName: 'Claude Code',
          models: [],
          reasoningEfforts: [],
          unavailableReason: 'private details',
        },
      ],
    };
    const settings = {
      getAgentProviderDefaults: () => ({ model: null, reasoningEffort: null }),
    };
    const catalog = await chatCatalog(
      registry as unknown as AgentRuntimeRegistryService,
      settings as unknown as SettingsService,
      'claude',
    );
    expect(catalog.error).toContain('try again');
    expect(catalog.error).not.toContain('private details');
    expect(catalog).toMatchObject({
      model: null,
      reasoning: null,
      fast: false,
    });
  });
});
