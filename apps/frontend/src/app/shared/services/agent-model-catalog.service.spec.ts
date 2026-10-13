import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentModelCatalogService } from './agent-model-catalog.service';

const catalog = (id: string, provider = 'codex') => ({
  provider,
  displayName: provider,
  models: [{ id, displayName: id }],
  reasoningEfforts: [],
  providerDefaultModelId: null,
  supportsModelSelection: true,
});

describe('AgentModelCatalogService', () => {
  let service: AgentModelCatalogService;
  let http: HttpTestingController;
  beforeEach(() => {
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://first-backend' };
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AgentModelCatalogService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
    delete window.__ELEVENEX_RUNTIME__;
  });

  it('coalesces reads and revalidates the catalog after a minute', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = service.load();
    expect(service.load()).toBe(first);
    http.expectOne('/api/agent-providers/models').flush([catalog('old')]);
    await first;
    await service.load();
    http.expectNone('/api/agent-providers/models');
    now.mockReturnValue(61_001);
    const second = service.load();
    http.expectOne('/api/agent-providers/models').flush([catalog('new')]);
    await second;
    expect(service.catalogs()[0].models[0].id).toBe('new');
  });

  it('loads only the requested provider while an unrelated provider is pending', async () => {
    const codex = service.load('codex');
    const claude = service.load('claude');
    expect(service.load('claude')).toBe(claude);
    http.expectNone('/api/agent-providers/models');
    http.expectOne('/api/agent-providers/claude/models').flush([catalog('sonnet', 'claude')]);
    await claude;
    expect(service.isLoading('claude')).toBe(false);
    expect(service.isLoading('codex')).toBe(true);
    await service.load('claude');
    http.expectNone('/api/agent-providers/claude/models');
    // A provider-only response must not mark the full settings catalog ready.
    expect(service.loaded()).toBe(false);
    http.expectOne('/api/agent-providers/codex/models').flush([catalog('codex')]);
    await codex;
  });

  it('starts a forced reload without waiting on an older full read', async () => {
    const load = service.load();
    const old = http.expectOne('/api/agent-providers/models');
    const refresh = service.refresh('codex');
    await Promise.resolve();
    http.expectOne('/api/agent-providers/codex/models/refresh').flush([catalog('fresh')]);
    await refresh;
    old.flush([catalog('old'), catalog('sonnet', 'claude')]);
    await load;
    expect(service.catalogs().map((item) => item.models[0].id)).toEqual(['fresh', 'sonnet']);
  });

  it('does not overwrite a newer provider read with an older full response', async () => {
    const all = service.load();
    const older = http.expectOne('/api/agent-providers/models');
    const provider = service.load('claude');
    http.expectOne('/api/agent-providers/claude/models').flush([catalog('fresh', 'claude')]);
    await provider;
    older.flush([catalog('old', 'claude'), catalog('codex')]);
    await all;
    expect(service.catalogs().map((item) => item.models[0].id)).toEqual(['fresh', 'codex']);
  });

  it('queues a full reload after provider reloads instead of racing them', async () => {
    const provider = service.refresh('claude');
    await Promise.resolve();
    const all = service.refresh();
    await Promise.resolve();
    http.expectNone('/api/agent-providers/models/refresh');
    http
      .expectOne('/api/agent-providers/claude/models/refresh')
      .flush([catalog('sonnet', 'claude')]);
    await provider;
    await Promise.resolve();
    http
      .expectOne('/api/agent-providers/models/refresh')
      .flush([catalog('sonnet', 'claude'), catalog('codex')]);
    await all;
    expect(service.loaded()).toBe(true);
    expect(service.loading()).toBe(false);
  });

  it('drops a forced response after switching backends without disturbing new requests', async () => {
    const first = service.refresh('codex');
    await Promise.resolve();
    const older = http.expectOne('/api/agent-providers/codex/models/refresh');
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://second-backend' };
    const second = service.load('claude');
    older.flush([catalog('old')]);
    await first;
    expect(service.catalogs()).toEqual([]);
    expect(service.isLoading('claude')).toBe(true);
    http.expectOne('/api/agent-providers/claude/models').flush([catalog('new', 'claude')]);
    await second;
    expect(service.catalogs()[0].models[0].id).toBe('new');
  });

  it('forces a provider refresh and keeps existing options visible until it finishes', async () => {
    const initial = service.load();
    http
      .expectOne('/api/agent-providers/models')
      .flush([catalog('old'), catalog('claude-old', 'claude')]);
    await initial;
    const first = service.refresh('codex');
    expect(service.refresh('codex')).toBe(first);
    expect(service.catalogs()[0].models[0].id).toBe('old');
    await Promise.resolve();
    const request = http.expectOne('/api/agent-providers/codex/models/refresh');
    expect(request.request.method).toBe('POST');
    request.flush([catalog('new')]);
    await first;
    expect(service.catalogs().map((item) => item.models[0].id)).toEqual(['new', 'claude-old']);
  });

  it('retains the working list and permits retry after a failed reload', async () => {
    const initial = service.load();
    http.expectOne('/api/agent-providers/models').flush([catalog('old')]);
    await initial;
    const refresh = service.refresh();
    await Promise.resolve();
    const rejected = expect(refresh).rejects.toBeDefined();
    http
      .expectOne('/api/agent-providers/models/refresh')
      .flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(service.catalogs()[0].models[0].id).toBe('old');
    expect(service.loading()).toBe(false);
    const retry = service.refresh();
    await Promise.resolve();
    http.expectOne('/api/agent-providers/models/refresh').flush([catalog('new')]);
    await retry;
    expect(service.error()).toBeNull();
  });

  it('never applies responses from a backend that was switched away from', async () => {
    const first = service.load();
    const old = http.expectOne('/api/agent-providers/models');
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://second-backend' };
    const second = service.load();
    http.expectOne('/api/agent-providers/models').flush([catalog('second')]);
    await second;
    old.flush([catalog('first')]);
    await first;
    expect(service.catalogs()[0].models[0].id).toBe('second');
    expect(service.loading()).toBe(false);
  });

  it('keeps the previous catalog when a provider cannot be reached', async () => {
    const initial = service.load();
    http.expectOne('/api/agent-providers/models').flush([catalog('working-model')]);
    await initial;
    const refresh = service.refresh('codex');
    await Promise.resolve();
    http.expectOne('/api/agent-providers/codex/models/refresh').flush([
      {
        ...catalog(''),
        models: [],
        unavailableReason: 'CLI unavailable',
      },
    ]);
    await refresh;
    expect(service.catalogs()[0].models[0].id).toBe('working-model');
    expect(service.catalogs()[0].unavailableReason).toBe('CLI unavailable');
  });
});
