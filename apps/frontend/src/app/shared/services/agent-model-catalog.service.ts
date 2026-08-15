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

  private loadPromise: Promise<AgentProviderModelCatalog[]> | null = null;
  private loadedOrigin: string | null = null;

  load(): Promise<AgentProviderModelCatalog[]> {
    const origin = getBackendOrigin();
    if (this.loadedOrigin === origin && this.loadPromise) {
      return this.loadPromise;
    }

    this.loadedOrigin = origin;
    this.loading.set(true);
    this.error.set(null);
    this.loadPromise = firstValueFrom(
      this.http.get<AgentProviderModelCatalog[]>('/api/agent-providers/models'),
    )
      .then((catalogs) => {
        const normalized = Array.isArray(catalogs) ? catalogs : [];
        this.catalogs.set(normalized);
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
}
