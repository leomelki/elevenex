import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { AgentProviderModelCatalog } from '@/shared/models/agent-model-catalog.model';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';

const CATALOG_TTL_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 3_000;
const BACKGROUND_RETRY_MS = 15_000;
const MAX_BACKGROUND_RETRY_MS = 5 * 60_000;
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

  private readonly codexPickers = new Set<symbol>();
  private codexRetryNeeded = false;
  private codexRetryDelay = BACKGROUND_RETRY_MS;
  private codexRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.clearCodexRetry();
      this.codexPickers.clear();
    });
  }

  /** Read current backend data without restarting the CLI or using the browser cache. */
  check(provider?: string): Promise<AgentProviderModelCatalog[]> {
    return this.requestCatalogs(false, provider, true);
  }

  /** A visible Codex picker temporarily accelerates the shared recovery loop. */
  watch(provider?: string): () => void {
    if (provider !== 'codex') return () => undefined;
    const picker = Symbol();
    this.codexPickers.add(picker);
    this.clearCodexRetry();
    void this.check(provider).catch(() => undefined);
    return () => {
      if (!this.codexPickers.delete(picker)) return;
      if (!this.codexPickers.size) this.codexRetryDelay = BACKGROUND_RETRY_MS;
      this.scheduleCodexRetry();
    };
  }

  private clearCodexRetry(): void {
    if (this.codexRetryTimer !== null) clearTimeout(this.codexRetryTimer);
    this.codexRetryTimer = null;
  }

  private scheduleCodexRetry(): void {
    this.clearCodexRetry();
    if (
      this.destroyed ||
      !this.codexRetryNeeded ||
      this.loads.has('codex') ||
      this.refreshes.has('codex') ||
      this.refreshes.has(ALL_PROVIDERS)
    )
      return;
    const foreground = this.codexPickers.size > 0;
    const delay = foreground ? UNAVAILABLE_RETRY_MS : this.codexRetryDelay;
    this.codexRetryTimer = setTimeout(() => {
      this.codexRetryTimer = null;
      if (!foreground) {
        this.codexRetryDelay =
          this.codexRetryDelay >= 120_000 ? MAX_BACKGROUND_RETRY_MS : this.codexRetryDelay * 2;
      }
      void this.check('codex').catch(() => undefined);
    }, delay);
  }

  isLoading(provider?: string): boolean {
    const pending = this.pendingProviders();
    return provider
      ? pending.includes(provider) ||
          (pending.includes(ALL_PROVIDERS) &&
            (!this.loadedAt.has(provider) || this.refreshes.has(ALL_PROVIDERS)))
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
      this.clearCodexRetry();
      this.codexRetryNeeded = false;
      this.codexRetryDelay = BACKGROUND_RETRY_MS;
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
    check = false,
  ): Promise<AgentProviderModelCatalog[]> {
    if (this.destroyed) return Promise.resolve([]);
    const generation = this.syncOrigin();
    const key = provider ?? ALL_PROVIDERS;
    const forced = this.refreshes.get(ALL_PROVIDERS) ?? this.refreshes.get(key);
    if (forced) return forced;
    const requests = refresh ? this.refreshes : this.loads;
    const existing = requests.get(key);
    if (existing) return existing;
    const loadedAt = this.loadedAt.get(key);
    const ttl = this.catalogsFor(provider).some((catalog) => catalog.unavailableReason)
      ? UNAVAILABLE_RETRY_MS
      : CATALOG_TTL_MS;
    if (!refresh && !check && loadedAt !== undefined && Date.now() - loadedAt < ttl) {
      return Promise.resolve(this.catalogsFor(provider));
    }

    this.error.set(null);
    // A full request follows any narrower forced refreshes. Provider reads
    // remain independent, even when an unrelated provider is slow.
    const priorRefreshes = provider ? [] : [...this.refreshes.values()];
    let requestRevision = 0;
    const fetchCatalogs = () => {
      if (!this.isCurrent(generation)) return Promise.resolve([]);
      const revision = ++this.revision;
      requestRevision = revision;
      const url = provider
        ? `/api/agent-providers/${encodeURIComponent(provider)}/models`
        : '/api/agent-providers/models';
      const response = refresh
        ? this.http.post<AgentProviderModelCatalog[]>(`${url}/refresh`, {})
        : this.http.get<AgentProviderModelCatalog[]>(url);
      const boundedResponse =
        provider === 'codex' ? response.pipe(timeout(refresh ? 45_000 : 30_000)) : response;
      return firstValueFrom(boundedResponse).then((catalogs) => {
        if (!this.isCurrent(generation)) return [];
        const normalized = this.normalizeAll(catalogs);
        this.applyCatalogs(normalized, revision, provider);
        if (!provider || provider === 'codex') {
          const codex = this.catalogs().find((catalog) => catalog.provider === 'codex');
          this.codexRetryNeeded = !!codex && (!codex.models.length || !!codex.unavailableReason);
          if (!this.codexRetryNeeded) this.codexRetryDelay = BACKGROUND_RETRY_MS;
        }
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
        const superseded = provider && (this.appliedRevision.get(provider) ?? 0) > requestRevision;
        if (this.isCurrent(generation) && !superseded) {
          if (!provider || provider === 'codex') this.codexRetryNeeded = true;
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
          if (this.isCurrent(generation) && (!provider || provider === 'codex')) {
            this.scheduleCodexRetry();
          }
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
    return !this.destroyed && generation === this.generation && this.origin === getBackendOrigin();
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
