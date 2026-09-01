import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ElectronWindowSummary } from '../runtime/electron-windows';

import { OnboardingStateService } from './onboarding-state.service';
import { OpenWindowsService } from './open-windows.service';

function summary(
  windowId: string,
  mode: 'local' | 'ssh' | 'wsl',
  serverId: number | null = null,
): ElectronWindowSummary {
  return {
    windowId,
    envRef: { mode, serverId, label: mode === 'ssh' ? `Server ${serverId}` : mode },
    label: mode === 'ssh' ? `Server ${serverId}` : mode,
    focused: false,
  };
}

describe('OpenWindowsService', () => {
  const onboardingStateMock = { refreshFromStorage: vi.fn() };
  let windowsApi: Record<string, ReturnType<typeof vi.fn>>;
  let broadcastListener: ((message: unknown) => void) | null;

  function configure(windows: ElectronWindowSummary[], available = true): OpenWindowsService {
    broadcastListener = null;
    windowsApi = {
      list: vi.fn(() => Promise.resolve(windows)),
      openNew: vi.fn().mockResolvedValue('w-new'),
      focus: vi.fn().mockResolvedValue(true),
      setEnvironment: vi.fn().mockResolvedValue(true),
      onChanged: vi.fn(() => () => {}),
      broadcast: vi.fn().mockResolvedValue(true),
      onBroadcast: vi.fn((callback: (message: unknown) => void) => {
        broadcastListener = callback;
        return () => {};
      }),
    };

    (window as unknown as { __ELEVENEX_RUNTIME__?: unknown }).__ELEVENEX_RUNTIME__ = {
      windowId: 'w-self',
    };
    (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__ = available
      ? { windows: windowsApi }
      : {};

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        OpenWindowsService,
        { provide: OnboardingStateService, useValue: onboardingStateMock },
      ],
    });

    return TestBed.inject(OpenWindowsService);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__;
    (window as unknown as { __ELEVENEX_RUNTIME__?: unknown }).__ELEVENEX_RUNTIME__ = {};
  });

  it('reports the windows the main process knows about', async () => {
    const service = configure([summary('w-self', 'local'), summary('w-other', 'ssh', 4)]);
    await service.refresh();

    expect(service.windows()).toHaveLength(2);
    expect(service.hasOtherWindows()).toBe(true);
  });

  it('excludes this window when answering "open elsewhere"', async () => {
    const service = configure([summary('w-self', 'ssh', 4)]);
    await service.refresh();

    expect(service.isOpenElsewhere({ mode: 'ssh', serverId: 4 })).toBe(false);
    expect(service.hasOtherWindows()).toBe(false);
  });

  it('matches remotes on server id, not just on mode', async () => {
    const service = configure([summary('w-other', 'ssh', 4)]);
    await service.refresh();

    expect(service.isOpenElsewhere({ mode: 'ssh', serverId: 4 })).toBe(true);
    expect(service.isOpenElsewhere({ mode: 'ssh', serverId: 5 })).toBe(false);
    expect(service.isOpenElsewhere({ mode: 'local', serverId: null })).toBe(false);
  });

  it('refreshes the shared catalogue when another window changes it', async () => {
    configure([summary('w-self', 'local')]);

    broadcastListener?.({ channel: 'environments:changed', payload: null });
    expect(onboardingStateMock.refreshFromStorage).toHaveBeenCalledTimes(1);

    broadcastListener?.({ channel: 'theme:changed', payload: 'dark' });
    expect(onboardingStateMock.refreshFromStorage).toHaveBeenCalledTimes(1);
  });

  it('degrades to a no-op outside the desktop app', async () => {
    const service = configure([], false);
    await service.refresh();

    expect(service.isMultiWindowSupported).toBe(false);
    expect(service.windows()).toEqual([]);
    expect(await service.openWindow({ mode: 'local', serverId: null, label: 'Local' })).toBe(false);
    expect(await service.focusWindow('w-other')).toBe(false);
  });

  it('survives a main process that cannot answer', async () => {
    const service = configure([summary('w-self', 'local')]);
    windowsApi['list'].mockRejectedValueOnce(new Error('gone'));

    await expect(service.refresh()).resolves.toBeUndefined();
  });
});
