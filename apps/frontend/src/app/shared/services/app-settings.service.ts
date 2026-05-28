import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  AppSettings,
  DefaultClaudeSessionSurface,
} from '@/shared/models/app-settings.model';

const DEFAULT_SETTINGS: AppSettings = {
  defaultClaudeSessionSurface: 'claude-ui',
  createdAt: null,
  updatedAt: null,
};

const VALID_SURFACES = new Set<DefaultClaudeSessionSurface>([
  'claude-ui',
  'tui',
]);

@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly http = inject(HttpClient);
  private readonly settingsState = signal<AppSettings>(DEFAULT_SETTINGS);
  private loadPromise: Promise<AppSettings> | null = null;

  readonly settings = this.settingsState.asReadonly();
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  load(): Promise<AppSettings> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loading.set(true);
    this.error.set(null);
    this.loadPromise = firstValueFrom(this.http.get<AppSettings>('/api/settings'))
      .then((settings) => {
        const normalized = this.normalize(settings);
        this.settingsState.set(normalized);
        return normalized;
      })
      .catch((error) => {
        this.error.set(this.errorMessage(error, 'Could not load settings.'));
        throw error;
      })
      .finally(() => {
        this.loading.set(false);
        this.loadPromise = null;
      });

    return this.loadPromise;
  }

  saveDefaultClaudeSessionSurface(
    defaultClaudeSessionSurface: DefaultClaudeSessionSurface,
  ): Promise<AppSettings> {
    if (!VALID_SURFACES.has(defaultClaudeSessionSurface)) {
      return Promise.reject(new Error('Unsupported Claude session surface.'));
    }

    const previous = this.settingsState();
    this.settingsState.set({
      ...previous,
      defaultClaudeSessionSurface,
    });
    this.saving.set(true);
    this.error.set(null);

    return firstValueFrom(
      this.http.patch<AppSettings>('/api/settings', {
        defaultClaudeSessionSurface,
      }),
    )
      .then((settings) => {
        const normalized = this.normalize(settings);
        this.settingsState.set(normalized);
        return normalized;
      })
      .catch((error) => {
        this.settingsState.set(previous);
        this.error.set(this.errorMessage(error, 'Could not save settings.'));
        throw error;
      })
      .finally(() => this.saving.set(false));
  }

  private normalize(settings: AppSettings | null | undefined): AppSettings {
    const surface = settings?.defaultClaudeSessionSurface;
    return {
      defaultClaudeSessionSurface: VALID_SURFACES.has(surface as DefaultClaudeSessionSurface)
        ? surface as DefaultClaudeSessionSurface
        : DEFAULT_SETTINGS.defaultClaudeSessionSurface,
      createdAt: settings?.createdAt ?? null,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'error' in error &&
      typeof (error as { error?: { message?: unknown } }).error?.message === 'string'
    ) {
      return (error as { error: { message: string } }).error.message;
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return fallback;
  }
}
