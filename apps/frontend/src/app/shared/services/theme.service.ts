import { Injectable, computed, effect, signal } from '@angular/core';

import { getElectronWindowsApi } from '../runtime/electron-windows';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'elevenex-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** Theme is an app preference, so a change in one window applies to all. */
export const THEME_CHANGED_CHANNEL = 'theme:changed';

function readStoredMode(): ThemeMode {
  if (typeof localStorage === 'undefined') {
    return 'system';
  }

  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches === true;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(readStoredMode());
  private readonly systemDark = signal(systemPrefersDark());
  readonly isDark = computed(() => (this.mode() === 'system' ? this.systemDark() : this.mode() === 'dark'));
  // Suppresses the re-broadcast when applying a change that came from another
  // window, so two windows do not ping-pong the same update.
  private applyingRemoteMode = false;

  constructor() {
    getElectronWindowsApi()?.onBroadcast((message) => {
      if (message?.channel !== THEME_CHANGED_CHANNEL) {
        return;
      }

      const mode = message.payload;
      if (mode === 'light' || mode === 'dark' || mode === 'system') {
        this.applyingRemoteMode = true;
        this.mode.set(mode);
      }
    });

    if (typeof window !== 'undefined' && window.matchMedia) {
      const media = window.matchMedia(DARK_QUERY);
      const onChange = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);
      if (media.addEventListener) {
        media.addEventListener('change', onChange);
      } else {
        media.addListener?.(onChange);
      }
    }

    effect(() => {
      const mode = this.mode();
      const isDark = this.isDark();

      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', isDark);
        document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      }

      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, mode);
      }

      if (this.applyingRemoteMode) {
        this.applyingRemoteMode = false;
        return;
      }

      void getElectronWindowsApi()?.broadcast(THEME_CHANGED_CHANNEL, mode);
    });
  }

  toggle() {
    this.mode.set(this.isDark() ? 'light' : 'dark');
  }

  useSystem() {
    this.mode.set('system');
  }
}
