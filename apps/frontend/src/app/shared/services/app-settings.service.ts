import { computed, inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {
  AppSettings,
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
} from '@/shared/models/app-settings.model';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';
import {
  normalizeSessionToolbarButtons,
  normalizeStoredSessionToolbarButtons,
  SessionToolbarButtonPreference,
} from '@/shared/models/session-toolbar-button.model';

const DEFAULT_SETTINGS: AppSettings = {
  defaultClaudeSessionSurface: 'claude-ui',
  defaultAgentProvider: 'claude',
  sessionToolbarButtons: null,
  onboardingCompletedAt: null,
  createdAt: null,
  updatedAt: null,
};

const VALID_SURFACES = new Set<DefaultClaudeSessionSurface>([
  'claude-ui',
  'tui',
]);
const VALID_AGENT_PROVIDERS = new Set<DefaultAgentProvider>([
  'claude',
  'codex',
  'pi',
]);

@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  private readonly http = inject(HttpClient);
  private readonly settingsState = signal<AppSettings>(DEFAULT_SETTINGS);
  private loadPromise: Promise<AppSettings> | null = null;
  private loadOrigin: string | null = null;
  private settingsOrigin: string | null = null;

  readonly settings = this.settingsState.asReadonly();
  readonly normalizedSessionToolbarButtons = computed(() =>
    normalizeSessionToolbarButtons(this.settingsState().sessionToolbarButtons),
  );
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  load(): Promise<AppSettings> {
    const origin = this.ensureCurrentOrigin();
    if (this.loadPromise && this.loadOrigin === origin) {
      return this.loadPromise;
    }

    this.loading.set(true);
    this.error.set(null);
    this.loadOrigin = origin;
    this.loadPromise = firstValueFrom(this.http.get<AppSettings>('/api/settings'))
      .then((settings) => {
        const normalized = this.normalize(settings);
        if (this.settingsOrigin === origin) {
          this.settingsState.set(normalized);
        }
        return normalized;
      })
      .catch((error) => {
        this.error.set(this.errorMessage(error, 'Could not load settings.'));
        throw error;
      })
      .finally(() => {
        this.loading.set(false);
        this.loadPromise = null;
        this.loadOrigin = null;
      });

    return this.loadPromise;
  }

  saveDefaultClaudeSessionSurface(
    defaultClaudeSessionSurface: DefaultClaudeSessionSurface,
  ): Promise<AppSettings> {
    if (!VALID_SURFACES.has(defaultClaudeSessionSurface)) {
      return Promise.reject(new Error('Unsupported Claude session surface.'));
    }

    return this.saveSettings({ defaultClaudeSessionSurface });
  }

  saveDefaultAgentProvider(
    defaultAgentProvider: DefaultAgentProvider,
  ): Promise<AppSettings> {
    if (!VALID_AGENT_PROVIDERS.has(defaultAgentProvider)) {
      return Promise.reject(new Error('Unsupported default agent provider.'));
    }

    return this.saveSettings({ defaultAgentProvider });
  }

  saveSessionToolbarButtons(
    sessionToolbarButtons: SessionToolbarButtonPreference[] | null,
  ): Promise<AppSettings> {
    return this.saveSettings({ sessionToolbarButtons });
  }

  completeOnboarding(input: {
    defaultAgentProvider: DefaultAgentProvider;
    defaultClaudeSessionSurface?: DefaultClaudeSessionSurface;
  }): Promise<AppSettings> {
    this.ensureCurrentOrigin();
    if (!VALID_AGENT_PROVIDERS.has(input.defaultAgentProvider)) {
      return Promise.reject(new Error('Unsupported default agent provider.'));
    }
    if (
      input.defaultClaudeSessionSurface
      && !VALID_SURFACES.has(input.defaultClaudeSessionSurface)
    ) {
      return Promise.reject(new Error('Unsupported Claude session surface.'));
    }

    const previous = this.settingsState();
    this.settingsState.set({
      ...previous,
      defaultAgentProvider: input.defaultAgentProvider,
      defaultClaudeSessionSurface:
        input.defaultAgentProvider === 'claude'
          ? input.defaultClaudeSessionSurface ?? previous.defaultClaudeSessionSurface
          : previous.defaultClaudeSessionSurface,
      onboardingCompletedAt: new Date().toISOString(),
    });
    this.saving.set(true);
    this.error.set(null);

    return firstValueFrom(
      this.http.post<AppSettings>('/api/settings/onboarding/complete', input),
    )
      .then((settings) => {
        const normalized = this.normalize(settings);
        this.settingsState.set(normalized);
        return normalized;
      })
      .catch((error) => {
        this.settingsState.set(previous);
        this.error.set(this.errorMessage(error, 'Could not save onboarding settings.'));
        throw error;
      })
      .finally(() => this.saving.set(false));
  }

  private saveSettings(
    patch: Partial<
      Pick<AppSettings, 'defaultAgentProvider' | 'defaultClaudeSessionSurface' | 'sessionToolbarButtons'>
    >,
  ): Promise<AppSettings> {
    this.ensureCurrentOrigin();
    const previous = this.settingsState();
    this.settingsState.set({
      ...previous,
      ...patch,
    });
    this.saving.set(true);
    this.error.set(null);

    return firstValueFrom(
      this.http.patch<AppSettings>('/api/settings', patch),
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
    const defaultAgentProvider = settings?.defaultAgentProvider;
    return {
      defaultClaudeSessionSurface: VALID_SURFACES.has(
        surface as DefaultClaudeSessionSurface,
      )
        ? (surface as DefaultClaudeSessionSurface)
        : DEFAULT_SETTINGS.defaultClaudeSessionSurface,
      defaultAgentProvider: VALID_AGENT_PROVIDERS.has(
        defaultAgentProvider as DefaultAgentProvider,
      )
        ? (defaultAgentProvider as DefaultAgentProvider)
        : DEFAULT_SETTINGS.defaultAgentProvider,
      sessionToolbarButtons: normalizeStoredSessionToolbarButtons(
        settings?.sessionToolbarButtons,
      ),
      onboardingCompletedAt: settings?.onboardingCompletedAt ?? null,
      createdAt: settings?.createdAt ?? null,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  private ensureCurrentOrigin(): string {
    const origin = getBackendOrigin();
    if (this.settingsOrigin !== origin) {
      this.settingsOrigin = origin;
      this.loadOrigin = null;
      this.loadPromise = null;
      this.settingsState.set(DEFAULT_SETTINGS);
      this.error.set(null);
    }
    return origin;
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
