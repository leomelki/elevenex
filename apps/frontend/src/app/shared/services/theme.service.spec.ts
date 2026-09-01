import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_CHANGED_CHANNEL, ThemeService } from './theme.service';
import { installMemoryLocalStorage } from '../testing/memory-storage';

describe('ThemeService across windows', () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let broadcastListener: ((message: unknown) => void) | null;

  function createService(): ThemeService {
    broadcast = vi.fn().mockResolvedValue(true);
    broadcastListener = null;

    (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__ = {
      windows: {
        list: vi.fn().mockResolvedValue([]),
        openNew: vi.fn(),
        focus: vi.fn(),
        setEnvironment: vi.fn(),
        onChanged: vi.fn(() => () => {}),
        broadcast,
        onBroadcast: vi.fn((callback: (message: unknown) => void) => {
          broadcastListener = callback;
          return () => {};
        }),
      },
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [ThemeService] });
    return TestBed.inject(ThemeService);
  }

  let restoreStorage: () => void;

  beforeEach(() => {
    restoreStorage = installMemoryLocalStorage();
  });

  afterEach(() => {
    delete (window as unknown as { __ELEVENEX_ELECTRON__?: unknown }).__ELEVENEX_ELECTRON__;
    restoreStorage();
  });

  it('tells the other windows when the theme changes', () => {
    const service = createService();
    broadcast.mockClear();

    service.toggle();
    TestBed.tick();

    expect(broadcast).toHaveBeenCalledWith(THEME_CHANGED_CHANNEL, service.mode());
  });

  it('applies a change made in another window', () => {
    const service = createService();

    broadcastListener?.({ channel: THEME_CHANGED_CHANNEL, payload: 'dark' });
    TestBed.tick();

    expect(service.mode()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not echo a change back to the window it came from', () => {
    // Two windows re-broadcasting each other's updates would loop.
    const service = createService();
    broadcast.mockClear();

    broadcastListener?.({ channel: THEME_CHANGED_CHANNEL, payload: 'dark' });
    TestBed.tick();

    expect(service.mode()).toBe('dark');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('ignores unrelated channels and malformed payloads', () => {
    const service = createService();
    const initial = service.mode();

    broadcastListener?.({ channel: 'environments:changed', payload: 'dark' });
    broadcastListener?.({ channel: THEME_CHANGED_CHANNEL, payload: 'neon' });
    TestBed.tick();

    expect(service.mode()).toBe(initial);
  });
});
