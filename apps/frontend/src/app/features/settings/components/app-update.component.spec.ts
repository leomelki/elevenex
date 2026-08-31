import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppUpdateComponent } from './app-update.component';
import type { AppUpdateState } from '@/shared/runtime/electron-updates';

function updateState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    supported: true,
    unsupportedReason: null,
    installKind: 'nsis',
    status: 'available',
    currentVersion: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    currentVersionShort: 'aaaaaaa',
    latestVersion: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    latestVersionShort: 'bbbbbbb',
    releaseUrl: 'https://github.com/leomelki/elevenex/releases/tag/runtime-bbbbbbb',
    publishedAt: '2026-08-30T10:00:00.000Z',
    assetName: 'elevenex-desktop-windows-x64.exe',
    downloadedBytes: 0,
    totalBytes: 1024,
    percent: null,
    message: null,
    error: null,
    lastCheckedAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  };
}

function stubUpdatesBridge(state: AppUpdateState) {
  const install = vi.fn(() => Promise.resolve(state));
  const check = vi.fn(() => Promise.resolve(state));
  window.__ELEVENEX_ELECTRON__ = {
    updates: {
      getState: () => Promise.resolve(state),
      check,
      install,
      openReleasePage: () => Promise.resolve(true),
      onStateChanged: () => () => {},
    },
  };

  return { check, install };
}

async function renderWith(state: AppUpdateState) {
  const bridge = stubUpdatesBridge(state);

  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [AppUpdateComponent] }).compileComponents();

  const fixture = TestBed.createComponent(AppUpdateComponent);
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();

  return { fixture, ...bridge };
}

describe('AppUpdateComponent', () => {
  beforeEach(() => {
    window.__ELEVENEX_ELECTRON__ = undefined;
  });

  it('renders nothing in the browser build', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({ imports: [AppUpdateComponent] }).compileComponents();

    const fixture = TestBed.createComponent(AppUpdateComponent);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent?.trim()).toBe('');
  });

  it('offers the newest published build and installs it on click', async () => {
    const { fixture, check, install } = await renderWith(updateState());
    const element = fixture.nativeElement as HTMLElement;

    // Opening the panel uses the cached check; only the explicit button forces one.
    expect(check).toHaveBeenCalledWith();
    expect(element.textContent).toContain('aaaaaaa');
    expect(element.textContent).toContain('Update to bbbbbbb');

    const updateButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Update to bbbbbbb'),
    );
    updateButton?.click();

    expect(install).toHaveBeenCalled();
  });

  it('reports being current without offering an install', async () => {
    const { fixture } = await renderWith(
      updateState({ status: 'up-to-date', latestVersion: null, latestVersionShort: null }),
    );
    const element = fixture.nativeElement as HTMLElement;

    expect(element.textContent).toContain('Up to date');
    expect(element.textContent).not.toContain('Update to');
  });

  it('surfaces install failures with a manual download escape hatch', async () => {
    const { fixture } = await renderWith(
      updateState({ status: 'error', error: 'Downloaded update failed checksum verification.' }),
    );
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Downloaded update failed checksum verification.',
    );
    expect(element.textContent).toContain('Download it manually');
  });

  it('asks for a restart once a package manager install has landed', async () => {
    const { fixture } = await renderWith(
      updateState({ installKind: 'deb', status: 'ready-to-restart' }),
    );

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Restart to finish');
  });
});
