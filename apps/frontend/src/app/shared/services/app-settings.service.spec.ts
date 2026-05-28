import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppSettingsService } from './app-settings.service';

describe('AppSettingsService', () => {
  let service: AppSettingsService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        AppSettingsService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    service = TestBed.inject(AppSettingsService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('coalesces concurrent settings loads', async () => {
    const first = service.load();
    const second = service.load();

    const request = httpMock.expectOne('/api/settings');
    request.flush({
      defaultClaudeSessionSurface: 'tui',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        defaultClaudeSessionSurface: 'tui',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        defaultClaudeSessionSurface: 'tui',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(service.settings().defaultClaudeSessionSurface).toBe('tui');
  });

  it('optimistically saves and rolls back when saving fails', async () => {
    const load = service.load();
    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });
    await load;

    const save = service.saveDefaultClaudeSessionSurface('tui');
    expect(service.settings().defaultClaudeSessionSurface).toBe('tui');

    httpMock.expectOne('/api/settings').flush(
      { message: 'Nope' },
      { status: 500, statusText: 'Server Error' },
    );

    await expect(save).rejects.toBeTruthy();
    expect(service.settings().defaultClaudeSessionSurface).toBe('claude-ui');
    expect(service.error()).toBe('Nope');
  });
});
