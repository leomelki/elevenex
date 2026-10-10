import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeProvider } from './agent-runtime.types.js';

describe('provider catalog capabilities', () => {
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
