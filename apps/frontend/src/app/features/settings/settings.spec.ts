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
    httpMock.verify();
  });

  it('renders Claude surface settings and app info', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });
    httpMock.expectOne('/api/info').flush({ backendSha: 'abcdef1234567890' });
    await Promise.resolve();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Workspace Preferences');
    expect(element.textContent).toContain('Claude UI');
    expect(element.textContent).toContain('TUI');
    expect(element.textContent).toContain('Elevenex');
    expect(element.textContent).toContain('@leomelki');
    expect(element.textContent).toContain('GitHub repository');
    expect(element.textContent).toContain('abcdef1');
    expect((element.querySelector('img') as HTMLImageElement | null)?.getAttribute('src')).toBe('11x.png');
  });

  it('saves the selected Claude surface and rolls back on failure', async () => {
    const fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();

    httpMock.expectOne('/api/settings').flush({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });
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
});
