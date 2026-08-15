import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AgentProviderModelCatalog } from '@/shared/models/agent-model-catalog.model';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

/**
 * Loads the per-provider model catalog used to populate the default-model and
 * thinking-level pickers in settings. Cached per backend origin with in-flight
 * de-duplication so repeated visits to the settings page don't refetch.
 */
@Injectable({ providedIn: 'root' })
export class AgentModelCatalogService {
  private readonly http = inject(HttpClient);

  readonly catalogs = signal<AgentProviderModelCatalog[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** True once a response has been applied, so the UI can tell empty from pending. */
  readonly loaded = signal(false);

  private loadPromise: Promise<AgentProviderModelCatalog[]> | null = null;
  private loadedOrigin: string | null = null;

  load(): Promise<AgentProviderModelCatalog[]> {
    const origin = getBackendOrigin();
    if (this.loadedOrigin === origin && this.loadPromise) {
      return this.loadPromise;
    }

    if (this.loadedOrigin !== origin) {
      // Switching backends invalidates the previous host's catalog.
      this.catalogs.set([]);
      this.loaded.set(false);
    }

    this.loadedOrigin = origin;
    this.loading.set(true);
    this.error.set(null);
    this.loadPromise = firstValueFrom(
      this.http.get<AgentProviderModelCatalog[]>('/api/agent-providers/models'),
    )
      .then((catalogs) => {
        const normalized = Array.isArray(catalogs)
          ? catalogs.map((catalog) => this.normalize(catalog))
          : [];
        this.catalogs.set(normalized);
        this.loaded.set(true);
        return normalized;
      })
      .catch((error) => {
        this.error.set('Could not load available models.');
        this.loadPromise = null;
        this.loadedOrigin = null;
        throw error;
      })
      .finally(() => this.loading.set(false));

    return this.loadPromise;
  }

  /**
   * Refetches even when cached — the provider lists are refreshed in the
   * background on the backend, so a retry can surface models that weren't
   * ready (or reachable) a moment ago.
   */
  refresh(): Promise<AgentProviderModelCatalog[]> {
    this.loadPromise = null;
    this.loadedOrigin = null;
    return this.load();
  }

  private normalize(
    catalog: AgentProviderModelCatalog,
  ): AgentProviderModelCatalog {
    return {
      ...catalog,
      models: Array.isArray(catalog?.models) ? catalog.models : [],
      reasoningEfforts: Array.isArray(catalog?.reasoningEfforts)
        ? catalog.reasoningEfforts
        : [],
      providerDefaultModelId: catalog?.providerDefaultModelId ?? null,
      supportsModelSelection: catalog?.supportsModelSelection !== false,
    };
  }
}
