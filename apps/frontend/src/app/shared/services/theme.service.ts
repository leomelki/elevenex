import { Injectable, computed, effect, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'elevenex-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

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

  constructor() {
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
    });
  }

  toggle() {
    this.mode.set(this.isDark() ? 'light' : 'dark');
  }

  useSystem() {
    this.mode.set('system');
  }
}
