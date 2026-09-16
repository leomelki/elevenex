import { jest } from '@jest/globals';
import { PiAgentRuntimeProvider } from './pi-agent-runtime.provider.js';

describe('PiAgentRuntimeProvider', () => {
  it('exposes and delegates conversation rewind support', async () => {
    const runtimeService = {
      on: jest.fn(),
      rewindConversation: jest.fn().mockResolvedValue([]),
    };
    const provider = new PiAgentRuntimeProvider(
      runtimeService as never,
      { on: jest.fn() } as never,
    );

    expect(provider.info.capabilities.rewindConversation).toBe(true);
    await expect(provider.rewindConversation(7, 'user-entry')).resolves.toEqual(
      [],
    );
    expect(runtimeService.rewindConversation).toHaveBeenCalledWith(
      7,
      'user-entry',
    );
  });
});
