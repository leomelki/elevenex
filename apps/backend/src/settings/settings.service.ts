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
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  MAX_AGENT_PREFERENCE_ENTRIES,
  MAX_AGENT_PREFERENCE_VALUE_LENGTH,
  SessionToolbarButtonSetting,
  UpdateAppSettingsInput,
} from './settings.types.js';

const SINGLETON_SETTINGS_ID = 1;

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
      return {
        defaultClaudeSessionSurface: DEFAULT_CLAUDE_SESSION_SURFACE,
        defaultAgentProvider: DEFAULT_AGENT_PROVIDER,
        sessionToolbarButtons: null,
        defaultModelByProvider: {},
        defaultReasoningEffortByProvider: {},
        onboardingCompletedAt: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    return this.toResponse(row);
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
      onboardingCompletedAt: current.onboardingCompletedAt,
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

    return {
      defaultClaudeSessionSurface,
      defaultAgentProvider,
      sessionToolbarButtons: this.parseSessionToolbarButtons(
        row.sessionToolbarButtons,
      ),
      defaultModelByProvider,
      defaultReasoningEffortByProvider,
      onboardingCompletedAt: row.onboardingCompletedAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
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
