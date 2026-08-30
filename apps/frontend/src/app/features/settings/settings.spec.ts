import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './settings';

vi.mock('ngx-sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

const APP_SETTINGS_RESPONSE = {
  defaultClaudeSessionSurface: 'claude-ui',
  defaultAgentProvider: 'claude',
  sessionToolbarButtons: null,
  defaultModelByProvider: {},
  defaultReasoningEffortByProvider: {},
  onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
  createdAt: null,
  updatedAt: null,
};

const LOCAL_MODELS_RESPONSE = {
  engineAvailable: true,
  engineError: null,
  cacheDir: '/home/user/.elevenex/whisper-models',
  selectedModel: 'small',
  models: [
    {
      id: 'small',
      label: 'Whisper Small',
      repo: 'onnx-community/whisper-small',
      downloadBytes: 254_000_000,
      speed: 'moderate',
      description: 'Accurate enough for technical dictation.',
      status: 'not-downloaded',
      loadedBytes: 0,
      progress: 0,
      currentFile: null,
      error: null,
      loadedInMemory: false,
    },
  ],
};

const MODEL_CATALOG_RESPONSE = [
  {
    provider: 'claude',
    displayName: 'Claude Code',
    models: [
      {
        id: 'opus',
        displayName: 'Opus',
        description: 'Higher-reasoning model.',
        supportsEffort: true,
      },
      {
        id: 'haiku',
        displayName: 'Haiku',
        description: 'Fast lower-cost model.',
        supportsEffort: false,
      },
    ],
    reasoningEfforts: ['low', 'medium', 'high'],
    providerDefaultModelId: null,
    supportsModelSelection: true,
  },
];

describe('Settings', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    window.__ELEVENEX_ELECTRON__ = undefined;
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [Settings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // The dictation panel watches offline model status while it is mounted.
    // jsdom has no EventSource, so it falls back to polling — drain whatever
    // that produced rather than asserting on a cadence.
    for (const request of httpMock.match((candidate) =>
      candidate.url.includes('/api/speech-to-text/local-models'),
    )) {
      request.flush(LOCAL_MODELS_RESPONSE);
    }
    httpMock.verify();
  });

  it('renders Claude surface settings and app info', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush(APP_SETTINGS_RESPONSE);
    httpMock
      .expectOne('/api/agent-providers/models')
      .flush(MODEL_CATALOG_RESPONSE);
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Workspace Preferences');
    expect(element.textContent).toContain('Default agent');
    expect(element.textContent).toContain('Codex');
    expect(element.textContent).toContain('Pi');
    expect(element.textContent).toContain('Claude UI');
    expect(element.textContent).toContain('TUI');
    expect(element.textContent).toContain('Session toolbar');
    expect(element.textContent).toContain('Reset to default');
    expect(element.textContent).toContain('Elevenex');
    expect(element.textContent).toContain('@leomelki');
    expect(element.textContent).toContain('GitHub repository');
    expect(element.textContent).toContain('abcdef1');
    expect((element.querySelector('img') as HTMLImageElement | null)?.getAttribute('src')).toBe('11x.png');
  });

  it('saves the selected Claude surface and rolls back on failure', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush(APP_SETTINGS_RESPONSE);
    httpMock
      .expectOne('/api/agent-providers/models')
      .flush(MODEL_CATALOG_RESPONSE);
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const tuiButton = buttons.find(button => button.textContent?.includes('TUI'));
    expect(tuiButton).toBeTruthy();

    tuiButton?.click();
    fixture.detectChanges();
    expect(tuiButton?.getAttribute('aria-pressed')).toBe('true');

    httpMock.expectOne('/api/settings').flush(
      { message: 'Could not save settings.' },
      { status: 500, statusText: 'Server Error' },
    );
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(tuiButton?.getAttribute('aria-pressed')).toBe('false');
  });

  it('saves and resets session toolbar button preferences', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush(APP_SETTINGS_RESPONSE);
    httpMock
      .expectOne('/api/agent-providers/models')
      .flush(MODEL_CATALOG_RESPONSE);
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const savePromise = fixture.componentInstance.setToolbarButtonVisibility('terminal', false);
    const saveRequest = httpMock.expectOne('/api/settings');
    expect(saveRequest.request.method).toBe('PATCH');
    expect(
      saveRequest.request.body.sessionToolbarButtons.find(
        (button: { id: string }) => button.id === 'terminal',
      ),
    ).toEqual({ id: 'terminal', visible: false });
    saveRequest.flush({
      ...APP_SETTINGS_RESPONSE,
      sessionToolbarButtons: saveRequest.request.body.sessionToolbarButtons,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await savePromise;

    const resetPromise = fixture.componentInstance.resetToolbarButtons();
    const resetRequest = httpMock.expectOne('/api/settings');
    expect(resetRequest.request.body.sessionToolbarButtons).toBeNull();
    resetRequest.flush({
      ...APP_SETTINGS_RESPONSE,
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    await resetPromise;
  });

  it('renders a model default row per provider from the catalog', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush(APP_SETTINGS_RESPONSE);
    httpMock
      .expectOne('/api/agent-providers/models')
      .flush(MODEL_CATALOG_RESPONSE);
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Model defaults');
    expect(element.textContent).toContain('Claude Code');
    expect(
      element.querySelector('[aria-label="Default model for Claude Code"]'),
    ).toBeTruthy();
    expect(
      element.querySelector(
        '[aria-label="Default thinking level for Claude Code"]',
      ),
    ).toBeTruthy();
  });

  it('saves a picked default model for just that provider', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush(APP_SETTINGS_RESPONSE);
    httpMock
      .expectOne('/api/agent-providers/models')
      .flush(MODEL_CATALOG_RESPONSE);
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const trigger = element.querySelector(
      '[aria-label="Default model for Claude Code"]',
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();

    const options = Array.from(
      document.querySelectorAll('[role="option"]'),
    ) as HTMLElement[];
    const opus = options.find((option) => option.textContent?.includes('Opus'));
    expect(opus).toBeTruthy();
    opus?.click();
    fixture.detectChanges();

    const request = httpMock.expectOne('/api/settings');
    expect(request.request.body).toEqual({
      defaultModelByProvider: { claude: 'opus' },
    });
    request.flush({
      ...APP_SETTINGS_RESPONSE,
      defaultModelByProvider: { claude: 'opus' },
    });
    await Promise.resolve();
    fixture.detectChanges();

    expect(trigger.textContent).toContain('Opus');
  });
});
