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
      sessionToolbarButtons: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        defaultClaudeSessionSurface: 'tui',
        sessionToolbarButtons: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        defaultClaudeSessionSurface: 'tui',
        sessionToolbarButtons: null,
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
      sessionToolbarButtons: null,
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

  it('normalizes session toolbar settings and appends new default buttons', async () => {
    const load = service.load();
    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      sessionToolbarButtons: [
        { id: 'terminal', visible: false },
        { id: 'unknown', visible: false },
      ],
      createdAt: null,
      updatedAt: null,
    });
    await load;

    const buttons = service.normalizedSessionToolbarButtons();
    expect(buttons[0]).toEqual({ id: 'terminal', visible: false });
    expect(buttons.some(button => button.id === 'unknown')).toBe(false);
    expect(buttons.some(button => button.id === 'agent')).toBe(true);
  });

  it('saves and resets session toolbar settings', async () => {
    const load = service.load();
    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      sessionToolbarButtons: null,
      createdAt: null,
      updatedAt: null,
    });
    await load;

    const save = service.saveSessionToolbarButtons([{ id: 'terminal', visible: false }]);
    expect(service.settings().sessionToolbarButtons).toEqual([
      { id: 'terminal', visible: false },
    ]);

    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      sessionToolbarButtons: [{ id: 'terminal', visible: false }],
      createdAt: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await save;

    const reset = service.saveSessionToolbarButtons(null);
    expect(service.settings().sessionToolbarButtons).toBeNull();

    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      sessionToolbarButtons: null,
      createdAt: null,
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    await reset;
  });
});
