import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeCleanup } from './agent-runtime.types.js';

@Injectable()
export class AgentRuntimeCleanupService implements AgentRuntimeCleanup {
  private readonly logger = new Logger(AgentRuntimeCleanupService.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async cleanupSession(sessionId: number): Promise<void> {
    const registry = this.moduleRef.get(AgentRuntimeRegistryService, {
      strict: false,
    });
    const providers = registry
      .listProviders()
      .map((providerInfo) => registry.getProvider(providerInfo.id));

    const results = await Promise.allSettled(
      providers.map((provider) => provider.cleanupSession(sessionId)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    if (failures.length === 0) {
      return;
    }

    for (const failure of failures) {
      this.logger.error(
        `Failed to clean up agent runtime for session ${sessionId}`,
        failure.reason instanceof Error
          ? failure.reason.stack
          : String(failure.reason),
      );
    }

    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to clean up ${failures.length} agent runtime provider(s) for session ${sessionId}`,
    );
  }
}
