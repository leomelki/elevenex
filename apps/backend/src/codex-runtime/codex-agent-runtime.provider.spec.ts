import { jest } from '@jest/globals';
import { CodexAgentRuntimeProvider } from './codex-agent-runtime.provider.js';

describe('CodexAgentRuntimeProvider', () => {
  it('prewarms the runtime when a client attaches', async () => {
    const runtimeService = {
      on: jest.fn(),
      prewarmSession: jest.fn().mockResolvedValue(undefined),
    };
    const provider = new CodexAgentRuntimeProvider(
      runtimeService as never,
      {} as never,
      { on: jest.fn() } as never,
    );

    provider.onClientAttached(7);
    await new Promise((resolve) => setImmediate(resolve));

    expect(runtimeService.prewarmSession).toHaveBeenCalledWith(7);
  });
});
