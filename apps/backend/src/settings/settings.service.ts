import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  AGENT_PROVIDER_KEY_PATTERN,
  AgentProviderDefaults,
  AgentProviderPreferenceMap,
  AgentProviderPreferencePatch,
  AppSettings,
  CLAUDE_SESSION_SURFACES,
  CompleteOnboardingInput,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_PROVIDERS,
  DEFAULT_CLAUDE_SESSION_SURFACE,
  DEFAULT_SPEECH_TO_TEXT_SETTINGS,
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  LOCAL_WHISPER_MODELS,
  LocalWhisperModelId,
  MAX_AGENT_PREFERENCE_ENTRIES,
  MAX_AGENT_PREFERENCE_VALUE_LENGTH,
  MAX_SPEECH_SETTING_VALUE_LENGTH,
  SPEECH_CLEANUP_MODES,
  SPEECH_TO_TEXT_PROVIDERS,
  SessionToolbarButtonSetting,
  SpeechCleanupMode,
  SpeechToTextProviderId,
  SpeechToTextSettings,
  UpdateAppSettingsInput,
  speechProviderRequiresApiKey,
} from './settings.types.js';

const SINGLETON_SETTINGS_ID = 1;

/**
 * Environment variables that override the stored dictation key, checked in
 * order. Lets a user keep the secret out of the SQLite file entirely.
 */
const SPEECH_API_KEY_ENV_VARS: Record<SpeechToTextProviderId, string[]> = {
  // The local engine has nothing to authenticate against.
  'local-whisper': [],
  elevenlabs: ['ELEVENEX_STT_API_KEY', 'ELEVENLABS_API_KEY'],
  'openai-compatible': ['ELEVENEX_STT_API_KEY', 'OPENAI_API_KEY'],
  openrouter: ['ELEVENEX_STT_API_KEY', 'OPENROUTER_API_KEY'],
};

/** Resolved dictation config for the speech-to-text module. */
export interface ResolvedSpeechToTextConfig extends SpeechToTextSettings {
  apiKey: string | null;
  apiKeyFromEnv: boolean;
}

const NO_PROVIDER_DEFAULTS: AgentProviderDefaults = {
  model: null,
  reasoningEffort: null,
};

@Injectable()
export class SettingsService implements OnModuleInit {
  /**
   * Last known per-provider defaults, kept in memory so agent runtimes can seed
   * a new session's model/thinking level synchronously while building runtime
   * state — no `await` on the hot session-creation path. Refreshed on every
   * read and write of the settings row.
   */
  private agentDefaultsCache: {
    models: AgentProviderPreferenceMap;
    reasoningEfforts: AgentProviderPreferenceMap;
  } = { models: {}, reasoningEfforts: {} };

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    // Warm the cache before any session can be created so the very first
    // session already starts on the configured model.
    await this.findOne().catch(() => undefined);
  }

  async findOne(): Promise<AppSettings> {
    const rows = await this.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.id, SINGLETON_SETTINGS_ID))
      .limit(1);

    const row = rows[0];
    if (!row) {
      const speechToText = { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS };
      const envKey = this.resolveApiKeyFromEnv(speechToText.provider);
      return {
        defaultClaudeSessionSurface: DEFAULT_CLAUDE_SESSION_SURFACE,
        defaultAgentProvider: DEFAULT_AGENT_PROVIDER,
        sessionToolbarButtons: null,
        defaultModelByProvider: {},
        defaultReasoningEffortByProvider: {},
        speechToText,
        speechToTextApiKeyConfigured: envKey !== null,
        speechToTextApiKeyFromEnv: envKey !== null,
        speechToTextRequiresApiKey: speechProviderRequiresApiKey(
          speechToText.provider,
        ),
        onboardingCompletedAt: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    return this.toResponse(row);
  }

  /**
   * Dictation config plus the resolved API key, for the speech-to-text module.
   * Never call this from anything that serializes its result to the client —
   * `findOne()` is the API-facing read and deliberately omits the key.
   */
  async getSpeechToTextConfig(): Promise<ResolvedSpeechToTextConfig> {
    const rows = await this.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.id, SINGLETON_SETTINGS_ID))
      .limit(1);

    const speechToText = this.parseSpeechToTextSettings(rows[0]?.speechToText);
    const envKey = this.resolveApiKeyFromEnv(speechToText.provider);
    const storedKey = rows[0]?.speechToTextApiKey?.trim() || null;

    return {
      ...speechToText,
      apiKey: envKey ?? storedKey,
      apiKeyFromEnv: envKey !== null,
    };
  }

  private resolveApiKeyFromEnv(provider: SpeechToTextProviderId): string | null {
    for (const name of SPEECH_API_KEY_ENV_VARS[provider] ?? []) {
      const value = process.env[name]?.trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  /**
   * Startup model/thinking level for `provider`, or nulls when the user hasn't
   * pinned one (meaning: defer to the provider's own default). Synchronous by
   * design — see `agentDefaultsCache`.
   */
  getAgentProviderDefaults(provider: string): AgentProviderDefaults {
    if (!provider) {
      return NO_PROVIDER_DEFAULTS;
    }

    return {
      model: this.agentDefaultsCache.models[provider] ?? null,
      reasoningEffort:
        this.agentDefaultsCache.reasoningEfforts[provider] ?? null,
    };
  }

  async update(input: UpdateAppSettingsInput): Promise<AppSettings> {
    const current = await this.findOne();
    const defaultClaudeSessionSurface =
      input.defaultClaudeSessionSurface ?? current.defaultClaudeSessionSurface;
    this.assertDefaultClaudeSessionSurface(defaultClaudeSessionSurface);
    const defaultAgentProvider =
      input.defaultAgentProvider ?? current.defaultAgentProvider;
    this.assertDefaultAgentProvider(defaultAgentProvider);

    const hasToolbarButtons = Object.prototype.hasOwnProperty.call(
      input,
      'sessionToolbarButtons',
    );
    const sessionToolbarButtons = hasToolbarButtons
      ? this.normalizeSessionToolbarButtons(input.sessionToolbarButtons)
      : current.sessionToolbarButtons;

    const defaultModelByProvider = this.mergeAgentPreferences(
      current.defaultModelByProvider,
      input.defaultModelByProvider,
      'default model',
    );
    const defaultReasoningEffortByProvider = this.mergeAgentPreferences(
      current.defaultReasoningEffortByProvider,
      input.defaultReasoningEffortByProvider,
      'default thinking level',
    );

    const speechToText = this.mergeSpeechToTextSettings(
      current.speechToText,
      input.speechToText,
    );

    const timestamp = new Date().toISOString();
    const row = {
      defaultClaudeSessionSurface,
      defaultAgentProvider,
      sessionToolbarButtons: this.serializeSessionToolbarButtons(
        sessionToolbarButtons,
      ),
      defaultModelByProvider: this.serializeAgentPreferences(
        defaultModelByProvider,
      ),
      defaultReasoningEffortByProvider: this.serializeAgentPreferences(
        defaultReasoningEffortByProvider,
      ),
      speechToText: JSON.stringify(speechToText),
      onboardingCompletedAt: current.onboardingCompletedAt,
      updatedAt: timestamp,
    };

    // Absent key => keep whatever is stored; explicit null/'' => clear it.
    const apiKeyPatch = Object.prototype.hasOwnProperty.call(
      input,
      'speechToTextApiKey',
    )
      ? { speechToTextApiKey: input.speechToTextApiKey?.trim() || null }
      : {};

    await this.db
      .insert(schema.appSettings)
      .values({
        id: SINGLETON_SETTINGS_ID,
        ...row,
        ...apiKeyPatch,
        createdAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [schema.appSettings.id],
        set: { ...row, ...apiKeyPatch },
      });

    return this.findOne();
  }

  async completeOnboarding(
    input: CompleteOnboardingInput,
  ): Promise<AppSettings> {
    const current = await this.findOne();
    this.assertDefaultAgentProvider(input.defaultAgentProvider);

    const defaultClaudeSessionSurface =
      input.defaultAgentProvider === 'claude'
        ? (input.defaultClaudeSessionSurface ??
          current.defaultClaudeSessionSurface)
        : current.defaultClaudeSessionSurface;
    this.assertDefaultClaudeSessionSurface(defaultClaudeSessionSurface);

    const timestamp = new Date().toISOString();
    const row = {
      defaultClaudeSessionSurface,
      defaultAgentProvider: input.defaultAgentProvider,
      sessionToolbarButtons: this.serializeSessionToolbarButtons(
        current.sessionToolbarButtons,
      ),
      defaultModelByProvider: this.serializeAgentPreferences(
        current.defaultModelByProvider,
      ),
      defaultReasoningEffortByProvider: this.serializeAgentPreferences(
        current.defaultReasoningEffortByProvider,
      ),
      onboardingCompletedAt: timestamp,
      updatedAt: timestamp,
    };

    await this.db
      .insert(schema.appSettings)
      .values({ id: SINGLETON_SETTINGS_ID, ...row, createdAt: timestamp })
      .onConflictDoUpdate({
        target: [schema.appSettings.id],
        set: row,
      });

    return this.findOne();
  }

  private toResponse(row: typeof schema.appSettings.$inferSelect): AppSettings {
    const defaultClaudeSessionSurface = CLAUDE_SESSION_SURFACES.includes(
      row.defaultClaudeSessionSurface as DefaultClaudeSessionSurface,
    )
      ? (row.defaultClaudeSessionSurface as DefaultClaudeSessionSurface)
      : DEFAULT_CLAUDE_SESSION_SURFACE;
    const defaultAgentProvider = DEFAULT_AGENT_PROVIDERS.includes(
      row.defaultAgentProvider as DefaultAgentProvider,
    )
      ? (row.defaultAgentProvider as DefaultAgentProvider)
      : DEFAULT_AGENT_PROVIDER;

    const defaultModelByProvider = this.parseAgentPreferences(
      row.defaultModelByProvider,
    );
    const defaultReasoningEffortByProvider = this.parseAgentPreferences(
      row.defaultReasoningEffortByProvider,
    );
    this.agentDefaultsCache = {
      models: defaultModelByProvider,
      reasoningEfforts: defaultReasoningEffortByProvider,
    };

    const speechToText = this.parseSpeechToTextSettings(row.speechToText);
    const envKey = this.resolveApiKeyFromEnv(speechToText.provider);

    return {
      defaultClaudeSessionSurface,
      defaultAgentProvider,
      sessionToolbarButtons: this.parseSessionToolbarButtons(
        row.sessionToolbarButtons,
      ),
      defaultModelByProvider,
      defaultReasoningEffortByProvider,
      speechToText,
      // Only ever a boolean — `row.speechToTextApiKey` must not appear in the
      // response. See the column comment in app-settings.schema.ts.
      speechToTextApiKeyConfigured:
        envKey !== null || Boolean(row.speechToTextApiKey?.trim()),
      speechToTextApiKeyFromEnv: envKey !== null,
      speechToTextRequiresApiKey: speechProviderRequiresApiKey(
        speechToText.provider,
      ),
      onboardingCompletedAt: row.onboardingCompletedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Applies a partial dictation patch on top of the stored config. Unknown and
   * malformed values are rejected rather than silently coerced, since a bad
   * base URL or provider id would otherwise surface as a confusing upstream
   * error at dictation time.
   */
  private mergeSpeechToTextSettings(
    current: SpeechToTextSettings,
    patch: Partial<SpeechToTextSettings> | null | undefined,
  ): SpeechToTextSettings {
    if (patch === undefined) {
      return current;
    }
    if (patch === null) {
      return { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS };
    }
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      throw new BadRequestException('Unsupported speech-to-text settings.');
    }

    const next: SpeechToTextSettings = { ...current };

    const bool = (key: 'enabled' | 'keytermsEnabled' | 'autoSend' | 'silenceAutoStop') => {
      const value = patch[key];
      if (value === undefined) return;
      if (typeof value !== 'boolean') {
        throw new BadRequestException(`Unsupported speech-to-text ${key}.`);
      }
      next[key] = value;
    };
    bool('enabled');
    bool('keytermsEnabled');
    bool('autoSend');
    bool('silenceAutoStop');

    const optionalText = (key: 'baseUrl' | 'model' | 'language' | 'cleanupModel') => {
      const value = patch[key];
      if (value === undefined) return;
      if (value === null || value === '') {
        next[key] = null;
        return;
      }
      if (
        typeof value !== 'string' ||
        value.length > MAX_SPEECH_SETTING_VALUE_LENGTH
      ) {
        throw new BadRequestException(`Unsupported speech-to-text ${key}.`);
      }
      next[key] = value.trim();
    };
    optionalText('baseUrl');
    optionalText('model');
    optionalText('language');
    optionalText('cleanupModel');

    if (next.baseUrl !== null && !/^https?:\/\//i.test(next.baseUrl)) {
      throw new BadRequestException(
        'Speech-to-text base URL must start with http:// or https://.',
      );
    }

    if (patch.provider !== undefined) {
      if (!SPEECH_TO_TEXT_PROVIDERS.includes(patch.provider)) {
        throw new BadRequestException('Unsupported speech-to-text provider.');
      }
      next.provider = patch.provider;
    }

    if (patch.localModel !== undefined) {
      if (!LOCAL_WHISPER_MODELS.includes(patch.localModel)) {
        throw new BadRequestException('Unsupported local Whisper model.');
      }
      next.localModel = patch.localModel;
    }

    if (patch.cleanupMode !== undefined) {
      if (!SPEECH_CLEANUP_MODES.includes(patch.cleanupMode)) {
        throw new BadRequestException('Unsupported transcript cleanup mode.');
      }
      next.cleanupMode = patch.cleanupMode;
    }

    if (patch.cleanupProvider !== undefined) {
      if (patch.cleanupProvider === null) {
        next.cleanupProvider = null;
      } else if (!DEFAULT_AGENT_PROVIDERS.includes(patch.cleanupProvider)) {
        throw new BadRequestException(
          'Unsupported transcript cleanup provider.',
        );
      } else {
        next.cleanupProvider = patch.cleanupProvider;
      }
    }

    return next;
  }

  /** Tolerant of hand-edited or legacy rows: unusable fields fall back to defaults. */
  private parseSpeechToTextSettings(
    value: string | null | undefined,
  ): SpeechToTextSettings {
    if (!value) {
      return { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS };
    }

    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS };
      }

      const raw = parsed as Record<string, unknown>;
      const bool = (key: keyof SpeechToTextSettings): boolean =>
        typeof raw[key] === 'boolean'
          ? (raw[key] as boolean)
          : (DEFAULT_SPEECH_TO_TEXT_SETTINGS[key] as boolean);
      const str = (key: keyof SpeechToTextSettings): string | null =>
        typeof raw[key] === 'string' && (raw[key] as string).trim().length > 0
          ? (raw[key] as string).trim()
          : null;

      return {
        enabled: bool('enabled'),
        provider: SPEECH_TO_TEXT_PROVIDERS.includes(
          raw.provider as SpeechToTextProviderId,
        )
          ? (raw.provider as SpeechToTextProviderId)
          : DEFAULT_SPEECH_TO_TEXT_SETTINGS.provider,
        baseUrl: str('baseUrl'),
        localModel: LOCAL_WHISPER_MODELS.includes(
          raw.localModel as LocalWhisperModelId,
        )
          ? (raw.localModel as LocalWhisperModelId)
          : DEFAULT_SPEECH_TO_TEXT_SETTINGS.localModel,
        model: str('model'),
        language: str('language'),
        keytermsEnabled: bool('keytermsEnabled'),
        cleanupMode: SPEECH_CLEANUP_MODES.includes(
          raw.cleanupMode as SpeechCleanupMode,
        )
          ? (raw.cleanupMode as SpeechCleanupMode)
          : DEFAULT_SPEECH_TO_TEXT_SETTINGS.cleanupMode,
        cleanupProvider: DEFAULT_AGENT_PROVIDERS.includes(
          raw.cleanupProvider as DefaultAgentProvider,
        )
          ? (raw.cleanupProvider as DefaultAgentProvider)
          : null,
        cleanupModel: str('cleanupModel'),
        autoSend: bool('autoSend'),
        silenceAutoStop: bool('silenceAutoStop'),
      };
    } catch {
      return { ...DEFAULT_SPEECH_TO_TEXT_SETTINGS };
    }
  }

  private assertDefaultClaudeSessionSurface(
    defaultClaudeSessionSurface: DefaultClaudeSessionSurface,
  ): void {
    if (!CLAUDE_SESSION_SURFACES.includes(defaultClaudeSessionSurface)) {
      throw new BadRequestException('Unsupported Claude session surface.');
    }
  }

  private assertDefaultAgentProvider(
    defaultAgentProvider: DefaultAgentProvider,
  ): void {
    if (!DEFAULT_AGENT_PROVIDERS.includes(defaultAgentProvider)) {
      throw new BadRequestException('Unsupported default agent provider.');
    }
  }

  /**
   * Applies a per-provider patch on top of the stored map. `null` clears an
   * entry, `undefined`/absent keys are left untouched, and a `null` patch
   * clears every provider at once.
   */
  private mergeAgentPreferences(
    current: AgentProviderPreferenceMap,
    patch: AgentProviderPreferencePatch | null | undefined,
    label: string,
  ): AgentProviderPreferenceMap {
    if (patch === undefined) {
      return current;
    }
    if (patch === null) {
      return {};
    }
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      throw new BadRequestException(`Unsupported ${label} settings.`);
    }

    const next: AgentProviderPreferenceMap = { ...current };
    for (const [provider, value] of Object.entries(patch)) {
      if (!AGENT_PROVIDER_KEY_PATTERN.test(provider)) {
        throw new BadRequestException(`Unsupported ${label} settings.`);
      }
      if (value === null || value === undefined || value === '') {
        delete next[provider];
        continue;
      }
      if (
        typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.length > MAX_AGENT_PREFERENCE_VALUE_LENGTH
      ) {
        throw new BadRequestException(`Unsupported ${label} settings.`);
      }
      next[provider] = value.trim();
    }

    if (Object.keys(next).length > MAX_AGENT_PREFERENCE_ENTRIES) {
      throw new BadRequestException(`Too many ${label} settings.`);
    }

    return next;
  }

  private serializeAgentPreferences(
    value: AgentProviderPreferenceMap,
  ): string | null {
    return Object.keys(value).length === 0 ? null : JSON.stringify(value);
  }

  /** Tolerant of hand-edited or legacy rows: unusable entries are dropped. */
  private parseAgentPreferences(
    value: string | null | undefined,
  ): AgentProviderPreferenceMap {
    if (!value) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {};
      }

      const result: AgentProviderPreferenceMap = {};
      for (const [provider, entry] of Object.entries(parsed)) {
        if (
          AGENT_PROVIDER_KEY_PATTERN.test(provider) &&
          typeof entry === 'string' &&
          entry.trim().length > 0 &&
          entry.length <= MAX_AGENT_PREFERENCE_VALUE_LENGTH
        ) {
          result[provider] = entry.trim();
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private normalizeSessionToolbarButtons(
    value: SessionToolbarButtonSetting[] | null | undefined,
  ): SessionToolbarButtonSetting[] | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException('Unsupported session toolbar settings.');
    }

    return value.map((button) => {
      if (
        typeof button !== 'object' ||
        button === null ||
        typeof button.id !== 'string' ||
        typeof button.visible !== 'boolean'
      ) {
        throw new BadRequestException('Unsupported session toolbar settings.');
      }

      return {
        id: button.id,
        visible: button.visible,
      };
    });
  }

  private serializeSessionToolbarButtons(
    value: SessionToolbarButtonSetting[] | null,
  ): string | null {
    return value === null ? null : JSON.stringify(value);
  }

  private parseSessionToolbarButtons(
    value: string | null | undefined,
  ): SessionToolbarButtonSetting[] | null {
    if (!value) {
      return null;
    }

    try {
      return this.normalizeSessionToolbarButtons(JSON.parse(value));
    } catch {
      return null;
    }
  }
}
