import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AGENT_RUNTIME_PROVIDERS } from './agent-runtime.tokens.js';
import { AGENT_REASONING_EFFORTS } from './agent-runtime.types.js';
import type {
  AgentProviderId,
  AgentProviderModelCatalog,
  AgentRuntimeProvider,
  AgentRuntimeProviderFeatures,
  AgentRuntimeProviderInfo,
} from './agent-runtime.types.js';

@Injectable()
export class AgentRuntimeRegistryService {
  private readonly logger = new Logger('AgentRuntimeRegistryService');
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

  /**
   * Model catalogs for every registered provider, in registration order. One
   * provider failing (CLI missing, signed out, slow) degrades to an empty
   * catalog for that provider instead of failing the whole request.
   */
  async listModelCatalogs(): Promise<AgentProviderModelCatalog[]> {
    return Promise.all(
      [...this.providersById.values()].map(async (provider) => {
        const base = {
          provider: provider.info.id,
          displayName: provider.info.displayName,
        };

        if (typeof provider.getModelCatalog !== 'function') {
          return {
            ...base,
            models: [],
            reasoningEfforts: [],
            providerDefaultModelId: null,
            supportsModelSelection: false,
          };
        }

        try {
          const catalog = await provider.getModelCatalog();
          return {
            ...base,
            ...catalog,
            reasoningEfforts: catalog.reasoningEfforts.length
              ? catalog.reasoningEfforts
              : [...AGENT_REASONING_EFFORTS],
          };
        } catch (error) {
          this.logger.debug(
            `Failed to load model catalog provider=${provider.info.id}: ${String(error)}`,
          );
          return {
            ...base,
            models: [],
            reasoningEfforts: [...AGENT_REASONING_EFFORTS],
            providerDefaultModelId: null,
            supportsModelSelection: true,
            unavailableReason: 'Could not reach this agent to list its models.',
          };
        }
      }),
    );
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
