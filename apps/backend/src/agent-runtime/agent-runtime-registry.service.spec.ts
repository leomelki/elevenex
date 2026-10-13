import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeProvider } from './agent-runtime.types.js';
import {
  clearBinaryPathCache,
  refreshLoginShellEnv,
} from '../config/system-paths.js';

jest.mock('../config/system-paths.js', () => ({
  clearBinaryPathCache: jest.fn(),
  refreshLoginShellEnv: jest.fn().mockResolvedValue(undefined),
}));

describe('provider catalog capabilities', () => {
  it('does not query an unrelated slow provider for a picker read', async () => {
    const payload = {
      models: [],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: true,
    };
    const claude = jest.fn().mockResolvedValue(payload);
    const codex = jest.fn(() => new Promise(() => {}));
    const registry = new AgentRuntimeRegistryService([
      {
        info: { id: 'claude', displayName: 'Claude' },
        getModelCatalog: claude,
      },
      { info: { id: 'codex', displayName: 'Codex' }, getModelCatalog: codex },
    ] as unknown as AgentRuntimeProvider[]);
    expect(
      (await registry.listModelCatalogs(false, 'claude')).map(
        (item) => item.provider,
      ),
    ).toEqual(['claude']);
    expect(codex).not.toHaveBeenCalled();
    await expect(registry.listModelCatalogs(false, 'missing')).rejects.toThrow(
      'not available',
    );
  });
  it('refreshes only the requested provider after re-resolving installed CLIs', async () => {
    const modelCatalog = {
      models: [],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: true,
    };
    const claude = jest.fn().mockResolvedValue(modelCatalog);
    const codex = jest.fn().mockResolvedValue(modelCatalog);
    const registry = new AgentRuntimeRegistryService([
      {
        info: { id: 'claude', displayName: 'Claude' },
        getModelCatalog: claude,
      },
      { info: { id: 'codex', displayName: 'Codex' }, getModelCatalog: codex },
    ] as unknown as AgentRuntimeProvider[]);
    const refreshed = await registry.refreshModelCatalogs('codex');
    expect(refreshLoginShellEnv).toHaveBeenCalledWith(true);
    expect(clearBinaryPathCache).toHaveBeenCalled();
    expect(codex).toHaveBeenCalledWith(true);
    expect(claude).not.toHaveBeenCalled();
    expect(refreshed.map((catalog) => catalog.provider)).toEqual(['codex']);
    await expect(registry.refreshModelCatalogs('missing')).rejects.toThrow(
      'not available',
    );
  });
  it('preserves an empty native variant list instead of offering unsupported effort levels', async () => {
    const registry = new AgentRuntimeRegistryService([
      {
        info: { id: 'opencode', displayName: 'OpenCode' },
        getModelCatalog: () =>
          Promise.resolve({
            models: [],
            reasoningEfforts: [],
            providerDefaultModelId: null,
            supportsModelSelection: true,
          }),
      } as unknown as AgentRuntimeProvider,
    ]);
    expect((await registry.listModelCatalogs())[0].reasoningEfforts).toEqual(
      [],
    );
  });
});
