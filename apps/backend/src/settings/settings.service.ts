import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  AGENT_PROVIDER_KEY_PATTERN,
  AgentModelPreset,
  AgentProviderDefaults,
  AgentProviderPreferenceMap,
  AgentProviderPreferencePatch,
  AppSettings,
  CLAUDE_SESSION_SURFACES,
  CompleteOnboardingInput,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_PROVIDERS,
  DEFAULT_CLAUDE_SESSION_SURFACE,
  DEFAULT_MAX_WORKTREES_PER_REPO,
  DEFAULT_RUN_TIME_LIMIT_HOURS,
  MAX_RUN_TIME_LIMIT_HOURS,
  DEFAULT_SPEECH_TO_TEXT_SETTINGS,
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  LOCAL_WHISPER_MODELS,
  LocalWhisperModelId,
  LastUsedAgentConfig,
  MAX_AGENT_PREFERENCE_ENTRIES,
  MAX_AGENT_PREFERENCE_VALUE_LENGTH,
  MAX_AGENT_MODEL_PRESETS,
  MAX_AGENT_MODEL_PRESET_NAME_LENGTH,
  MAX_SPEECH_LANGUAGES,
  MAX_SPEECH_SETTING_VALUE_LENGTH,
  MAX_WORKTREES_PER_REPO_CEILING,
  SPEECH_CLEANUP_MODES,
  SPEECH_TO_TEXT_PROVIDERS,
  SessionToolbarButtonSetting,
  SpeechCleanupMode,
  SpeechToTextProviderId,
  SpeechToTextSettings,
  UpdateAppSettingsInput,
  isSpeechLanguageCode,
  speechProviderRequiresApiKey,
} from './settings.types.js';

const SINGLETON_SETTINGS_ID = 1;

/**
 * Reads the dictation language set from a stored row, accepting the single
 * `language` string written before the set existed. Rows are only rewritten
 * when the user next saves, so the legacy shape has to keep working
 * indefinitely rather than being migrated once at startup.
 */
function parseSpeechLanguages(raw: Record<string, unknown>): string[] {
  const source = Array.isArray(raw.languages)
    ? raw.languages
    : [raw.language].filter((value) => value !== undefined);

  const languages: string[] = [];
  for (const value of source) {
    const code = typeof value === 'string' ? value.trim().toLowerCase() : null;
    if (code && isSpeechLanguageCode(code) && !languages.includes(code)) {
      languages.push(code);
    }
  }
  return languages.slice(0, MAX_SPEECH_LANGUAGES);
}

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
  private runTimeLimitHours = DEFAULT_RUN_TIME_LIMIT_HOURS;

  /** Cached for run-state events; changes apply to the next response. */
  getRunTimeLimitHours(): number {
    return this.runTimeLimitHours;
  }

  /**
   * Last known per-provider defaults, kept in memory so agent runtimes can seed
   * a new session's model/thinking level synchronously while building runtime
   * state — no `await` on the hot session-creation path. Refreshed on every
   * read and write of the settings row.
   */
  private defaultPresets: AgentModelPreset[] = [];
  private presetDefaultProvider: DefaultAgentProvider = DEFAULT_AGENT_PROVIDER;
  private lastUsedAgentConfig: LastUsedAgentConfig | null = null;

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
        agentModelPresets: [],
        maxWorktreesPerRepo: DEFAULT_MAX_WORKTREES_PER_REPO,
        runTimeLimitHours: DEFAULT_RUN_TIME_LIMIT_HOURS,
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

  private resolveApiKeyFromEnv(
    provider: SpeechToTextProviderId,
  ): string | null {
    for (const name of SPEECH_API_KEY_ENV_VARS[provider] ?? []) {
      const value = process.env[name]?.trim();
      if (value) {
        return value;
      }
    }
    return null;
  }

  /**
   * Startup config for `provider`: explicit defaults, then the last used mix,
   * then nulls to defer to the provider. Synchronous by design — see
   * `agentDefaultsCache`.
   */
  getAgentProviderDefaults(provider: string): AgentProviderDefaults {
    if (!provider) {
      return NO_PROVIDER_DEFAULTS;
    }

    const preset = this.defaultPresets.find(
      (item) => item.provider === provider && item.isDefault,
    );
    if (preset)
      return {
        model: preset.model,
        reasoningEffort: preset.reasoningEffort,
        fastMode: preset.fastMode ?? false,
      };
    if (
      !this.hasAgentProviderDefault(provider) &&
      this.lastUsedAgentConfig?.provider === provider
    ) {
      const { model, reasoningEffort, fastMode } = this.lastUsedAgentConfig;
      return { model, reasoningEffort, fastMode };
    }
    return {
      model: this.agentDefaultsCache.models[provider] ?? null,
      reasoningEffort:
        this.agentDefaultsCache.reasoningEfforts[provider] ?? null,
    };
  }

  /** Called after findOne() refreshes the cache; explicit defaults always win. */
  getInitialAgentProvider(
    provider: DefaultAgentProvider,
  ): DefaultAgentProvider {
    return this.hasAgentProviderDefault(provider)
      ? provider
      : (this.lastUsedAgentConfig?.provider ?? provider);
  }

  private hasAgentProviderDefault(provider: string): boolean {
    return (
      this.defaultPresets.some((p) => p.provider === provider && p.isDefault) ||
      Object.hasOwn(this.agentDefaultsCache.models, provider) ||
      Object.hasOwn(this.agentDefaultsCache.reasoningEfforts, provider)
    );
  }

  async rememberAgentConfig(value: unknown): Promise<void> {
    const config = this.parseLastUsedAgentConfig(value);
    if (!config) throw new BadRequestException('Invalid agent configuration.');
    const serialized = JSON.stringify(config);
    if (serialized === JSON.stringify(this.lastUsedAgentConfig)) return;
    // Patch only this column, so recent use cannot overwrite a concurrent default edit.
    await this.db
      .insert(schema.appSettings)
      .values({ id: SINGLETON_SETTINGS_ID, lastUsedAgentConfig: serialized })
      .onConflictDoUpdate({
        target: schema.appSettings.id,
        set: { lastUsedAgentConfig: serialized },
      });
    this.lastUsedAgentConfig = config;
  }

  private parseLastUsedAgentConfig(value: unknown): LastUsedAgentConfig | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const config = value as Record<string, unknown>;
    const provider = DEFAULT_AGENT_PROVIDERS.find((p) => p === config.provider);
    const validChoice = (choice: unknown): choice is string | null =>
      choice === null ||
      (typeof choice === 'string' &&
        choice.length > 0 &&
        choice.length <= 1000);
    if (
      !provider ||
      !validChoice(config.model) ||
      !validChoice(config.reasoningEffort) ||
      typeof config.fastMode !== 'boolean'
    )
      return null;
    return {
      provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastMode: config.fastMode,
    };
  }

  getAgentModelPresets(): readonly AgentModelPreset[] {
    return this.defaultPresets.map((preset) => ({ ...preset }));
  }

  getAgentPresetDefault() {
    return {
      id:
        this.defaultPresets.find(
          (p) => p.provider === this.presetDefaultProvider && p.isDefault,
        )?.id ?? null,
      provider: this.presetDefaultProvider,
      defaultIds: this.defaultPresets
        .filter((p) => p.isDefault)
        .map((p) => p.id),
      revision: createHash('sha256')
        .update(
          JSON.stringify([
            this.presetDefaultProvider,
            this.defaultPresets.map((p) => [
              p.id,
              p.name,
              p.provider,
              p.model,
              p.reasoningEffort,
              !!p.fastMode,
              !!p.isDefault,
            ]),
          ]),
        )
        .digest('hex'),
    };
  }

  assertPresetDefaultRevision(revision: unknown): void {
    if (revision !== this.getAgentPresetDefault().revision)
      throw new ConflictException(
        'The default or saved presets changed. Refresh before trying again.',
      );
  }

  setAgentPresetDefault(id: string, revision: string) {
    return this.changePresetDefaults(revision, (presets) => {
      const selected = presets.find((p) => p.id === id);
      if (!selected)
        throw new BadRequestException('This preset is no longer available.');
      return {
        provider: selected.provider,
        defaultIds: [
          ...presets
            .filter((p) => p.isDefault && p.provider !== selected.provider)
            .map((p) => p.id),
          id,
        ],
      };
    });
  }

  restoreAgentPresetDefault(
    snapshot: { provider: string; defaultIds: readonly string[] },
    revision: string,
  ) {
    return this.changePresetDefaults(revision, () => snapshot);
  }

  /** At most 24 small records: keep the comparison and write in one SQLite transaction. */
  private changePresetDefaults(
    revision: string,
    choose: (presets: readonly AgentModelPreset[]) => {
      provider: string;
      defaultIds: readonly string[];
    },
  ) {
    return this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.id, SINGLETON_SETTINGS_ID))
        .get();
      if (row) this.toResponse(row);
      this.assertPresetDefaultRevision(revision);
      const before = this.getAgentPresetDefault();
      const next = choose(this.defaultPresets);
      const provider = DEFAULT_AGENT_PROVIDERS.find((p) => p === next.provider);
      if (
        !provider ||
        next.defaultIds.length > MAX_AGENT_MODEL_PRESETS ||
        new Set(next.defaultIds).size !== next.defaultIds.length ||
        next.defaultIds.some(
          (id) => !this.defaultPresets.some((p) => p.id === id),
        )
      )
        throw new BadRequestException('Invalid preset defaults.');
      const presets = this.normalizeAgentModelPresets(
        this.defaultPresets.map((p) => ({
          ...p,
          isDefault: next.defaultIds.includes(p.id),
        })),
        true,
      );
      const values = {
        defaultAgentProvider: provider,
        agentModelPresets: JSON.stringify(presets),
      };
      tx.insert(schema.appSettings)
        .values({ id: SINGLETON_SETTINGS_ID, ...values })
        .onConflictDoUpdate({
          target: schema.appSettings.id,
          set: { ...values, updatedAt: new Date().toISOString() },
        })
        .run();
      this.defaultPresets = presets;
      this.presetDefaultProvider = provider;
      return { before, after: this.getAgentPresetDefault() };
    });
  }

  /** A small synchronous transaction prevents concurrent creators losing each other's presets. */
  addAgentModelPreset(
    preset: AgentModelPreset,
    makeDefault = false,
    expectedRevision?: string,
  ) {
    const next = this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.id, SINGLETON_SETTINGS_ID))
        .get();
      const current = row ? this.toResponse(row).agentModelPresets : [];
      if (makeDefault) this.assertPresetDefaultRevision(expectedRevision);
      const before = this.getAgentPresetDefault();
      const existing = current.find((item) => item.id === preset.id);
      if (existing) {
        if (
          existing.name !== preset.name ||
          existing.provider !== preset.provider ||
          existing.model !== preset.model ||
          existing.reasoningEffort !== preset.reasoningEffort ||
          !!existing.fastMode !== !!preset.fastMode
        )
          throw new BadRequestException(
            'This preset identity is already in use.',
          );
        return { presets: current, change: undefined };
      }
      if (
        current.some(
          (item) => item.name.toLowerCase() === preset.name.toLowerCase(),
        )
      )
        throw new BadRequestException(
          'A preset with this name already exists.',
        );
      if (current.length >= MAX_AGENT_MODEL_PRESETS)
        throw new BadRequestException(
          'You can save up to 24 presets. Remove an unused preset in Settings first.',
        );
      const presets = this.normalizeAgentModelPresets(
        [preset, ...current].map((p) =>
          makeDefault && p.provider === preset.provider
            ? { ...p, isDefault: p.id === preset.id }
            : p,
        ),
        true,
      );
      const provider = makeDefault
        ? DEFAULT_AGENT_PROVIDERS.find((p) => p === preset.provider)
        : undefined;
      if (makeDefault && !provider)
        throw new BadRequestException('Unsupported default agent provider.');
      const defaults = provider ? { defaultAgentProvider: provider } : {};
      tx.insert(schema.appSettings)
        .values({
          id: SINGLETON_SETTINGS_ID,
          agentModelPresets: JSON.stringify(presets),
          ...defaults,
        })
        .onConflictDoUpdate({
          target: schema.appSettings.id,
          set: {
            agentModelPresets: JSON.stringify(presets),
            ...defaults,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
      this.defaultPresets = presets;
      if (provider) this.presetDefaultProvider = provider;
      return {
        presets,
        change: makeDefault
          ? { before, after: this.getAgentPresetDefault() }
          : undefined,
      };
    });
    this.defaultPresets = next.presets;
    return next.change;
  }

  /**
   * Worktrees a repo may hold before creating another one needs the human's
   * go-ahead. `0` means the cap is off. Read fresh rather than cached: it is
   * only consulted on worktree creation, never on a hot path, and a stale cap
   * would be read as the human's answer to a question they never saw.
   */
  async getMaxWorktreesPerRepo(): Promise<number> {
    const settings = await this.findOne();
    return settings.maxWorktreesPerRepo;
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
    const agentModelPresets =
      input.agentModelPresets === undefined
        ? current.agentModelPresets.map((preset) => ({ ...preset }))
        : this.normalizeAgentModelPresets(input.agentModelPresets, true);

    if (
      input.agentModelPresets === undefined &&
      (input.defaultModelByProvider !== undefined ||
        input.defaultReasoningEffortByProvider !== undefined)
    ) {
      for (const preset of agentModelPresets) {
        if (!preset.isDefault) continue;
        if (
          input.defaultModelByProvider === null ||
          Object.hasOwn(input.defaultModelByProvider ?? {}, preset.provider)
        )
          preset.model = defaultModelByProvider[preset.provider] ?? null;
        if (
          input.defaultReasoningEffortByProvider === null ||
          Object.hasOwn(
            input.defaultReasoningEffortByProvider ?? {},
            preset.provider,
          )
        )
          preset.reasoningEffort =
            defaultReasoningEffortByProvider[preset.provider] ?? null;
      }
    }

    // Once presets are edited, they own startup defaults. Clear the legacy maps
    // so deleting a default cannot resurrect an old model preference.
    if (input.agentModelPresets !== undefined) {
      for (const provider of new Set(
        [...current.agentModelPresets, ...agentModelPresets].map(
          (item) => item.provider,
        ),
      )) {
        delete defaultModelByProvider[provider];
        delete defaultReasoningEffortByProvider[provider];
      }
    }

    const maxWorktreesPerRepo =
      input.maxWorktreesPerRepo === undefined
        ? current.maxWorktreesPerRepo
        : this.assertMaxWorktreesPerRepo(input.maxWorktreesPerRepo);

    const speechToText = this.mergeSpeechToTextSettings(
      current.speechToText,
      input.speechToText,
    );

    const runTimeLimitHours =
      input.runTimeLimitHours === undefined
        ? current.runTimeLimitHours
        : this.assertRunTimeLimitHours(input.runTimeLimitHours);

    const timestamp = new Date().toISOString();
    const row = {
      defaultClaudeSessionSurface,
      defaultAgentProvider,
      maxWorktreesPerRepo,
      runTimeLimitHours,
      sessionToolbarButtons: this.serializeSessionToolbarButtons(
        sessionToolbarButtons,
      ),
      defaultModelByProvider: this.serializeAgentPreferences(
        defaultModelByProvider,
      ),
      defaultReasoningEffortByProvider: this.serializeAgentPreferences(
        defaultReasoningEffortByProvider,
      ),
      agentModelPresets: JSON.stringify(agentModelPresets),
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
      maxWorktreesPerRepo: current.maxWorktreesPerRepo,
      runTimeLimitHours: current.runTimeLimitHours,
      sessionToolbarButtons: this.serializeSessionToolbarButtons(
        current.sessionToolbarButtons,
      ),
      defaultModelByProvider: this.serializeAgentPreferences(
        current.defaultModelByProvider,
      ),
      defaultReasoningEffortByProvider: this.serializeAgentPreferences(
        current.defaultReasoningEffortByProvider,
      ),
      agentModelPresets: JSON.stringify(current.agentModelPresets),
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
    this.lastUsedAgentConfig = null;
    if (row.lastUsedAgentConfig && row.lastUsedAgentConfig.length <= 8192) {
      try {
        this.lastUsedAgentConfig = this.parseLastUsedAgentConfig(
          JSON.parse(row.lastUsedAgentConfig),
        );
      } catch {
        /* A malformed optional snapshot must not block settings or startup. */
      }
    }
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

    this.presetDefaultProvider = defaultAgentProvider;
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

    const agentModelPresets = this.parseAgentModelPresets(
      row.agentModelPresets,
    );
    // Expose old defaults through the same editor without requiring a schema migration.
    for (const provider of new Set([
      ...Object.keys(defaultModelByProvider),
      ...Object.keys(defaultReasoningEffortByProvider),
    ])) {
      if (
        agentModelPresets.some(
          (preset) => preset.provider === provider && preset.isDefault,
        )
      )
        continue;
      const model = defaultModelByProvider[provider] ?? null;
      const reasoningEffort =
        defaultReasoningEffortByProvider[provider] ?? null;
      const matching = agentModelPresets.find(
        (preset) =>
          preset.provider === provider &&
          preset.model === model &&
          preset.reasoningEffort === reasoningEffort,
      );
      if (matching) matching.isDefault = true;
      else if (agentModelPresets.length < MAX_AGENT_MODEL_PRESETS) {
        let id = `default-${provider}`;
        while (agentModelPresets.some((preset) => preset.id === id))
          id = `d-${randomUUID()}`;
        agentModelPresets.push({
          id,
          name: `${provider} default`,
          provider,
          model,
          reasoningEffort,
          isDefault: true,
          fastMode: false,
        });
      }
    }
    this.defaultPresets = agentModelPresets;
    const speechToText = this.parseSpeechToTextSettings(row.speechToText);
    const envKey = this.resolveApiKeyFromEnv(speechToText.provider);

    this.runTimeLimitHours = this.isValidRunTimeLimitHours(
      row.runTimeLimitHours,
    )
      ? row.runTimeLimitHours
      : DEFAULT_RUN_TIME_LIMIT_HOURS;

    return {
      defaultClaudeSessionSurface,
      defaultAgentProvider,
      sessionToolbarButtons: this.parseSessionToolbarButtons(
        row.sessionToolbarButtons,
      ),
      defaultModelByProvider,
      defaultReasoningEffortByProvider,
      agentModelPresets,
      maxWorktreesPerRepo: this.parseMaxWorktreesPerRepo(
        row.maxWorktreesPerRepo,
      ),
      runTimeLimitHours: this.runTimeLimitHours,
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

    const bool = (
      key: 'enabled' | 'keytermsEnabled' | 'autoSend' | 'silenceAutoStop',
    ) => {
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

    const optionalText = (key: 'baseUrl' | 'model' | 'cleanupModel') => {
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
    optionalText('cleanupModel');

    if (patch.languages !== undefined) {
      if (!Array.isArray(patch.languages)) {
        throw new BadRequestException('Unsupported speech-to-text languages.');
      }
      if (patch.languages.length > MAX_SPEECH_LANGUAGES) {
        throw new BadRequestException(
          `Pick at most ${MAX_SPEECH_LANGUAGES} dictation languages.`,
        );
      }
      const languages: string[] = [];
      for (const language of patch.languages) {
        if (!isSpeechLanguageCode(language)) {
          throw new BadRequestException(
            'Unsupported speech-to-text languages.',
          );
        }
        // Order carries meaning — the first is the fallback — but a repeat adds
        // nothing, so keep the earliest occurrence.
        if (!languages.includes(language)) {
          languages.push(language);
        }
      }
      next.languages = languages;
    }

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
        languages: parseSpeechLanguages(raw),
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

  private parseAgentModelPresets(
    value: string | null | undefined,
  ): AgentModelPreset[] {
    if (!value) return [];
    try {
      return this.normalizeAgentModelPresets(JSON.parse(value), false);
    } catch {
      return [];
    }
  }

  private normalizeAgentModelPresets(
    value: unknown,
    strict: boolean,
  ): AgentModelPreset[] {
    const fail = () => {
      if (strict) throw new BadRequestException('Unsupported model presets.');
      return [] as AgentModelPreset[];
    };
    if (!Array.isArray(value) || value.length > MAX_AGENT_MODEL_PRESETS)
      return fail();
    const result: AgentModelPreset[] = [];
    const ids = new Set<string>();
    const defaultProviders = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return fail();
      const raw = item as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const provider =
        typeof raw.provider === 'string' ? raw.provider.trim() : '';
      const nullable = (field: unknown): string | null | undefined => {
        if (field === null || field === undefined || field === '') return null;
        return typeof field === 'string' ? field.trim() : undefined;
      };
      const model = nullable(raw.model);
      const reasoningEffort = nullable(raw.reasoningEffort);
      if (
        !AGENT_PROVIDER_KEY_PATTERN.test(id) ||
        ids.has(id) ||
        !name ||
        name.length > MAX_AGENT_MODEL_PRESET_NAME_LENGTH ||
        !AGENT_PROVIDER_KEY_PATTERN.test(provider) ||
        (raw.fastMode !== undefined && typeof raw.fastMode !== 'boolean') ||
        (raw.isDefault !== undefined && typeof raw.isDefault !== 'boolean') ||
        (raw.isDefault === true && defaultProviders.has(provider)) ||
        model === undefined ||
        reasoningEffort === undefined ||
        (model?.length ?? 0) > MAX_AGENT_PREFERENCE_VALUE_LENGTH ||
        (reasoningEffort?.length ?? 0) > MAX_AGENT_PREFERENCE_VALUE_LENGTH
      )
        return fail();
      ids.add(id);
      if (raw.isDefault === true) defaultProviders.add(provider);
      result.push({
        id,
        name,
        provider,
        model,
        reasoningEffort,
        ...(raw.fastMode !== undefined
          ? { fastMode: raw.fastMode as boolean }
          : {}),
        ...(raw.isDefault !== undefined
          ? { isDefault: raw.isDefault as boolean }
          : {}),
      });
    }
    return result;
  }

  private assertDefaultAgentProvider(
    defaultAgentProvider: DefaultAgentProvider,
  ): void {
    if (!DEFAULT_AGENT_PROVIDERS.includes(defaultAgentProvider)) {
      throw new BadRequestException('Unsupported default agent provider.');
    }
  }

  private assertMaxWorktreesPerRepo(value: number): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_WORKTREES_PER_REPO_CEILING
    ) {
      throw new BadRequestException(
        `Worktree limit must be a whole number between 0 and ${MAX_WORKTREES_PER_REPO_CEILING} (0 disables the limit).`,
      );
    }
    return value;
  }

  private isValidRunTimeLimitHours(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= MAX_RUN_TIME_LIMIT_HOURS
    );
  }

  private assertRunTimeLimitHours(value: number): number {
    if (!this.isValidRunTimeLimitHours(value)) {
      throw new BadRequestException(
        `Run time limit must be between 0 and ${MAX_RUN_TIME_LIMIT_HOURS} hours (0 disables the limit).`,
      );
    }
    return value;
  }

  /** Tolerant of hand-edited rows: an unusable value falls back to the default. */
  private parseMaxWorktreesPerRepo(value: number | null | undefined): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > MAX_WORKTREES_PER_REPO_CEILING
    ) {
      return DEFAULT_MAX_WORKTREES_PER_REPO;
    }
    return value;
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
