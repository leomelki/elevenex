import '@angular/compiler';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { provideZard } from '@/shared/core/provider/providezard';
import { ModelCatalogRefreshComponent } from './model-catalog-refresh.component';

describe('ModelCatalogRefreshComponent', () => {
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
