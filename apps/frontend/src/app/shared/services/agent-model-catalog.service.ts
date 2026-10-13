import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AgentProviderModelCatalog } from '@/shared/models/agent-model-catalog.model';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

const CATALOG_TTL_MS = 60_000;
const ALL_PROVIDERS = '*';

/** Bounded per-backend cache shared by settings and session pickers. */
@Injectable({ providedIn: 'root' })
export class AgentModelCatalogService {
  private readonly http = inject(HttpClient);
  readonly catalogs = signal<AgentProviderModelCatalog[]>([]);
  readonly error = signal<string | null>(null);
  /** True once a full catalog has been loaded for settings. */
  readonly loaded = signal(false);
  private readonly pendingProviders = signal<string[]>([]);
  private readonly refreshingProviders = signal<string[]>([]);
  readonly loading = computed(() => this.pendingProviders().length > 0);

  private origin: string | null = null;
  private generation = 0;
  private revision = 0;
  private readonly loadedAt = new Map<string, number>();
  private readonly appliedRevision = new Map<string, number>();
  private readonly loads = new Map<string, Promise<AgentProviderModelCatalog[]>>();
  private readonly refreshes = new Map<string, Promise<AgentProviderModelCatalog[]>>();

  isLoading(provider?: string): boolean {
    const pending = this.pendingProviders();
    return provider
      ? pending.includes(ALL_PROVIDERS) || pending.includes(provider)
      : pending.length > 0;
  }

  isRefreshing(provider?: string): boolean {
    const pending = this.refreshingProviders();
    return provider
      ? pending.includes(ALL_PROVIDERS) || pending.includes(provider)
      : pending.length > 0;
  }

  load(provider?: string): Promise<AgentProviderModelCatalog[]> {
    return this.requestCatalogs(false, provider);
  }

  /** Bypass frontend and provider caches; retain options while discovery runs. */
  refresh(provider?: string): Promise<AgentProviderModelCatalog[]> {
    return this.requestCatalogs(true, provider);
  }

  private syncOrigin(): number {
    const origin = getBackendOrigin();
    if (this.origin !== origin) {
      this.origin = origin;
      this.generation++;
      this.loadedAt.clear();
      this.appliedRevision.clear();
      this.loads.clear();
      this.refreshes.clear();
      this.catalogs.set([]);
      this.loaded.set(false);
      this.updateLoading();
      this.error.set(null);
    }
    return this.generation;
  }

  private requestCatalogs(
    refresh: boolean,
    provider?: string,
  ): Promise<AgentProviderModelCatalog[]> {
    const generation = this.syncOrigin();
    const key = provider ?? ALL_PROVIDERS;
    const forced = this.refreshes.get(ALL_PROVIDERS) ?? this.refreshes.get(key);
    if (forced) return forced;
    const requests = refresh ? this.refreshes : this.loads;
    const existing = requests.get(key);
    if (existing) return existing;
    const loadedAt = this.loadedAt.get(key);
    if (!refresh && loadedAt !== undefined && Date.now() - loadedAt < CATALOG_TTL_MS) {
      return Promise.resolve(this.catalogsFor(provider));
    }

    this.error.set(null);
    // A full request follows any narrower forced refreshes. Provider reads
    // remain independent, even when an unrelated provider is slow.
    const priorRefreshes = provider ? [] : [...this.refreshes.values()];
    const fetchCatalogs = () => {
      if (!this.isCurrent(generation)) return Promise.resolve([]);
      const revision = ++this.revision;
      const url = provider
        ? `/api/agent-providers/${encodeURIComponent(provider)}/models`
        : '/api/agent-providers/models';
      const response = refresh
        ? this.http.post<AgentProviderModelCatalog[]>(`${url}/refresh`, {})
        : this.http.get<AgentProviderModelCatalog[]>(url);
      return firstValueFrom(response).then((catalogs) => {
        if (!this.isCurrent(generation)) return [];
        const normalized = this.normalizeAll(catalogs);
        this.applyCatalogs(normalized, revision, provider);
        return normalized;
      });
    };
    // Ordinary reads start immediately. Reloads don't wait on older reads;
    // revision checks keep late responses from overwriting fresh discoveries.
    const pending =
      refresh || priorRefreshes.length
        ? Promise.allSettled(priorRefreshes).then(fetchCatalogs)
        : fetchCatalogs();
    const request = pending
      .catch((error) => {
        if (this.isCurrent(generation)) {
          this.error.set(
            refresh
              ? 'Could not refresh models. Your previous list is still available.'
              : 'Could not load available models.',
          );
        }
        throw error;
      })
      .finally(() => {
        if (requests.get(key) === request) {
          requests.delete(key);
          this.updateLoading();
        }
      });
    requests.set(key, request);
    this.updateLoading();
    return request;
  }

  private applyCatalogs(
    catalogs: AgentProviderModelCatalog[],
    revision: number,
    provider?: string,
  ): void {
    const previous = new Map(this.catalogs().map((catalog) => [catalog.provider, catalog]));
    const updated = provider ? new Map(previous) : new Map<string, AgentProviderModelCatalog>();
    const now = Date.now();
    for (const catalog of catalogs) {
      const id = catalog.provider;
      if ((this.appliedRevision.get(id) ?? 0) > revision) {
        const newer = previous.get(id);
        if (newer) updated.set(id, newer);
        continue;
      }
      updated.set(id, catalog);
      this.appliedRevision.set(id, revision);
      this.loadedAt.set(id, now);
    }
    // A narrower response may add a provider missing from an older full read.
    if (!provider) {
      for (const [id, catalog] of previous) {
        if ((this.appliedRevision.get(id) ?? 0) > revision) updated.set(id, catalog);
      }
      this.loaded.set(true);
      this.loadedAt.set(ALL_PROVIDERS, now);
    }
    this.catalogs.set([...updated.values()]);
  }

  private catalogsFor(provider?: string): AgentProviderModelCatalog[] {
    return provider
      ? this.catalogs().filter((catalog) => catalog.provider === provider)
      : this.catalogs();
  }

  private updateLoading(): void {
    this.pendingProviders.set([...new Set([...this.loads.keys(), ...this.refreshes.keys()])]);
    this.refreshingProviders.set([...this.refreshes.keys()]);
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.origin === getBackendOrigin();
  }

  private normalizeAll(catalogs: AgentProviderModelCatalog[]): AgentProviderModelCatalog[] {
    const previous = new Map(this.catalogs().map((catalog) => [catalog.provider, catalog]));
    return Array.isArray(catalogs)
      ? catalogs.map((catalog) => {
          const normalized = {
            ...catalog,
            models: Array.isArray(catalog?.models) ? catalog.models : [],
            reasoningEfforts: Array.isArray(catalog?.reasoningEfforts)
              ? catalog.reasoningEfforts
              : [],
            providerDefaultModelId: catalog?.providerDefaultModelId ?? null,
            supportsModelSelection: catalog?.supportsModelSelection !== false,
          };
          const working = previous.get(normalized.provider);
          return normalized.unavailableReason && !normalized.models.length && working
            ? { ...working, unavailableReason: normalized.unavailableReason }
            : normalized;
        })
      : [];
  }
}
