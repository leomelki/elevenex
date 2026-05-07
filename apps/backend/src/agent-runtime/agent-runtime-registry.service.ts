import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AGENT_RUNTIME_PROVIDERS } from './agent-runtime.tokens.js';
import type {
  AgentProviderId,
  AgentRuntimeProvider,
  AgentRuntimeProviderFeatures,
  AgentRuntimeProviderInfo,
} from './agent-runtime.types.js';

@Injectable()
export class AgentRuntimeRegistryService {
  private readonly providersById: Map<string, AgentRuntimeProvider>;

  constructor(
    @Inject(AGENT_RUNTIME_PROVIDERS)
    providers: AgentRuntimeProvider[],
  ) {
    this.providersById = new Map(
      providers.map((provider) => [provider.info.id, provider]),
    );
  }

  listProviders(): AgentRuntimeProviderInfo[] {
    return [...this.providersById.values()].map((provider) => provider.info);
  }

  getProvider(providerId: AgentProviderId = 'claude'): AgentRuntimeProvider {
    const provider = this.providersById.get(providerId);
    if (!provider) {
      throw new NotFoundException(
        `Agent provider "${providerId}" is not available.`,
      );
    }
    return provider;
  }

  getProviderFeature<Feature extends keyof AgentRuntimeProviderFeatures>(
    providerId: AgentProviderId,
    feature: Feature,
  ): AgentRuntimeProvider &
    Required<Pick<AgentRuntimeProviderFeatures, Feature>> {
    const provider = this.getProvider(providerId);
    if (typeof provider[feature] !== 'function') {
      throw new BadRequestException(
        `Agent provider "${providerId}" does not support ${String(feature)}.`,
      );
    }
    return provider as AgentRuntimeProvider &
      Required<Pick<AgentRuntimeProviderFeatures, Feature>>;
  }
}
