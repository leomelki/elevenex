import { ModuleRef } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AgentRuntimeCleanupService } from './agent-runtime-cleanup.service.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeProvider } from './agent-runtime.types.js';

const createProvider = (
  id: string,
  cleanupSession = jest.fn().mockResolvedValue(undefined),
): AgentRuntimeProvider =>
  ({
    info: {
      id,
      displayName: id,
      capabilities: {
        mcp: false,
        subagents: false,
        permissions: false,
        userInput: false,
        multimodalPrompts: false,
        terminalFallback: false,
        rewindConversation: false,
      },
    },
    cleanupSession,
  }) as AgentRuntimeProvider;

describe('AgentRuntimeCleanupService', () => {
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
  });

  it('cleans up every registered provider for the session', async () => {
    const claude = createProvider('claude');
    const codex = createProvider('codex');
    const service = createService([claude, codex]);

    await service.cleanupSession(42);

    expect(claude.cleanupSession).toHaveBeenCalledWith(42);
    expect(codex.cleanupSession).toHaveBeenCalledWith(42);
  });

  it('attempts every provider before surfacing cleanup failures', async () => {
    const failure = new Error('cleanup failed');
    const claude = createProvider(
      'claude',
      jest.fn().mockRejectedValue(failure),
    );
    const codex = createProvider('codex');
    const service = createService([claude, codex]);

    await expect(service.cleanupSession(7)).rejects.toThrow(AggregateError);

    expect(claude.cleanupSession).toHaveBeenCalledWith(7);
    expect(codex.cleanupSession).toHaveBeenCalledWith(7);
  });
});

function createService(providers: AgentRuntimeProvider[]) {
  const registry = new AgentRuntimeRegistryService(providers);
  const moduleRef = {
    get: jest.fn((token) => {
      if (token === AgentRuntimeRegistryService) {
        return registry;
      }
      throw new Error(`Unexpected token: ${String(token)}`);
    }),
  } as unknown as ModuleRef;

  return new AgentRuntimeCleanupService(moduleRef);
}
