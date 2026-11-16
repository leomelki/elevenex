import '@angular/compiler';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provideZard } from '@/shared/core/provider/providezard';
import { ModelCatalogRefreshComponent } from './model-catalog-refresh.component';

describe('ModelCatalogRefreshComponent', () => {
  afterEach(() => vi.useRealTimers());

  it('shows discovery and failure states, retries quickly while open, and returns to background recovery on close', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [ModelCatalogRefreshComponent],
      providers: [provideZard(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(ModelCatalogRefreshComponent);
    fixture.componentRef.setInput('provider', 'codex');
    const service = fixture.componentInstance.catalog;
    const http = TestBed.inject(HttpTestingController);
    const loading = service.load('codex');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Checking models');
    expect(fixture.nativeElement.querySelector('button').getAttribute('aria-busy')).toBe('true');
    const unavailable = {
      provider: 'codex',
      displayName: 'Codex',
      models: [],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: true,
      unavailableReason: 'Install Codex and sign in.',
    };
    http.expectOne('/api/agent-providers/codex/models').flush([unavailable]);
    await loading;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]').textContent).toContain(
      'Install Codex',
    );
    await vi.advanceTimersByTimeAsync(3_001);
    http.expectOne('/api/agent-providers/codex/models').flush([unavailable]);
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(3_001);
    http.expectNone('/api/agent-providers/codex/models');
    await vi.advanceTimersByTimeAsync(12_000);
    http.expectOne('/api/agent-providers/codex/models').flush([unavailable]);
    await vi.advanceTimersByTimeAsync(0);
    http.verify();
  });
  it('uses background cadence for mounted but hidden dropdown content', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [ModelCatalogRefreshComponent],
      providers: [provideZard(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(ModelCatalogRefreshComponent);
    fixture.componentRef.setInput('provider', 'codex');
    fixture.componentRef.setInput('active', false);
    const service = fixture.componentInstance.catalog;
    const http = TestBed.inject(HttpTestingController);
    const loading = service.load('codex');
    const unavailable = {
      provider: 'codex',
      displayName: 'Codex',
      models: [],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: true,
      unavailableReason: 'Install Codex.',
    };
    http.expectOne('/api/agent-providers/codex/models').flush([unavailable]);
    await loading;
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(3_001);
    http.expectNone('/api/agent-providers/codex/models');
    fixture.componentRef.setInput('active', true);
    fixture.detectChanges();
    http.expectOne('/api/agent-providers/codex/models').flush([unavailable]);
    await vi.advanceTimersByTimeAsync(0);
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(3_001);
    http.expectNone('/api/agent-providers/codex/models');
    await vi.advanceTimersByTimeAsync(12_000);
    http.expectOne('/api/agent-providers/codex/models').flush([]);
    await vi.advanceTimersByTimeAsync(0);
    fixture.destroy();
    http.verify();
  });

  it.each(['light', 'dark'])(
    'allows a provider reload while an unrelated read is slow in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      try {
        await TestBed.configureTestingModule({
          imports: [ModelCatalogRefreshComponent],
          providers: [provideZard(), provideHttpClient(), provideHttpClientTesting()],
        }).compileComponents();
        const fixture = TestBed.createComponent(ModelCatalogRefreshComponent);
        fixture.componentRef.setInput('provider', 'claude');
        const service = fixture.componentInstance.catalog;
        const http = TestBed.inject(HttpTestingController);
        const read = service.load();
        const old = http.expectOne('/api/agent-providers/models');
        fixture.detectChanges();
        const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        const refreshed = fixture.componentInstance.refresh(new Event('click'));
        fixture.detectChanges();
        expect(button.disabled).toBe(true);
        await Promise.resolve();
        const catalog = {
          provider: 'claude',
          displayName: 'Claude',
          models: [{ id: 'sonnet', displayName: 'Sonnet', description: '' }],
          reasoningEfforts: [],
          providerDefaultModelId: null,
          supportsModelSelection: true,
        };
        http.expectOne('/api/agent-providers/claude/models/refresh').flush([catalog]);
        await refreshed;
        fixture.detectChanges();
        expect(button.disabled).toBe(false);
        expect(fixture.nativeElement.textContent).toContain('Models are up to date.');
        old.flush([catalog]);
        await read;
        http.verify();
      } finally {
        document.documentElement.classList.remove('dark');
      }
    },
  );
});
