import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto.js';
import { SettingsService } from './settings.service.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import {
  DEFAULT_MAX_WORKTREES_PER_REPO,
  DEFAULT_SPEECH_TO_TEXT_SETTINGS,
  MAX_WORKTREES_PER_REPO_CEILING,
} from './settings.types.js';

/**
 * The dictation key can come from the environment, so a developer with
 * ELEVENLABS_API_KEY exported would otherwise see these tests fail.
 */
const SPEECH_ENV_VARS = [
  'ELEVENEX_STT_API_KEY',
  'ELEVENLABS_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
];

function createDbMock(initialRows: unknown[] = []) {
  const rows = [...initialRows];
  const limit = jest.fn(async () => rows);
  const where = jest.fn(() => ({ limit, get: () => rows[0] }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const onConflictDoUpdate = jest.fn(
    ({ set }: { set: Record<string, unknown> }) => {
      const values = valuesMock.mock.calls.at(-1)?.[0] as Record<
        string,
        unknown
      >;
      const index = rows.findIndex(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          'id' in row &&
          row.id === values.id,
      );

      if (index === -1) {
        rows.push(values);
      } else {
        rows[index] = {
          ...(rows[index] as Record<string, unknown>),
          ...set,
        };
      }
      return { run: () => undefined };
    },
  );
  const valuesMock = jest.fn(() => ({ onConflictDoUpdate }));
  const insert = jest.fn(() => ({ values: valuesMock }));

  return {
    db: {
      select,
      insert,
      transaction: (run: (tx: unknown) => unknown) => run({ select, insert }),
    } as unknown as DrizzleDB,
    getRows: () => rows,
    mocks: {
      select,
      from,
      where,
      limit,
      insert,
      values: valuesMock,
      onConflictDoUpdate,
    },
  };
}

describe('SettingsService', () => {
  it('persists the last mix across service restarts without creating or changing defaults', async () => {
    const { db, sqlite } = createTestDb();
    try {
      const settings = new SettingsService(db);
      const config = {
        provider: 'codex',
        model: 'gpt',
        reasoningEffort: 'high',
        fastMode: true,
      };
      const before = settings.getAgentPresetDefault();
      await settings.rememberAgentConfig(config);
      const restarted = new SettingsService(db);
      await restarted.onModuleInit();
      expect(restarted.getInitialAgentProvider('claude')).toBe('codex');
      expect(restarted.getAgentProviderDefaults('codex')).toEqual({
        model: 'gpt',
        reasoningEffort: 'high',
        fastMode: true,
      });
      expect(restarted.getAgentProviderDefaults('claude')).toEqual({
        model: null,
        reasoningEffort: null,
      });
      expect(restarted.getAgentPresetDefault()).toEqual(before);
      expect((await restarted.findOne()).defaultAgentProvider).toBe('claude');
      await restarted.update({ runTimeLimitHours: 2 });
      await restarted.findOne();
      expect(restarted.getAgentProviderDefaults('codex').fastMode).toBe(true);
      await restarted.rememberAgentConfig({
        ...config,
        model: null,
        reasoningEffort: null,
        fastMode: false,
      });
      expect(restarted.getAgentProviderDefaults('codex')).toEqual({
        model: null,
        reasoningEffort: null,
        fastMode: false,
      });
    } finally {
      sqlite.close();
    }
  });
  it('prefers explicit preset and legacy defaults over the last used mix', async () => {
    const { db } = createDbMock();
    const settings = new SettingsService(db);
    await settings.rememberAgentConfig({
      provider: 'codex',
      model: 'recent',
      reasoningEffort: 'low',
      fastMode: true,
    });
    await settings.update({ defaultModelByProvider: { codex: 'pinned' } });
    expect(settings.getInitialAgentProvider('codex')).toBe('codex');
    expect(settings.getAgentProviderDefaults('codex')).toMatchObject({
      model: 'pinned',
      reasoningEffort: null,
    });
    settings.addAgentModelPreset(
      {
        id: 'pinned',
        name: 'Pinned',
        provider: 'claude',
        model: null,
        reasoningEffort: null,
      },
      true,
      settings.getAgentPresetDefault().revision,
    );
    expect(settings.getInitialAgentProvider('claude')).toBe('claude');
    expect(settings.getAgentProviderDefaults('claude')).toEqual({
      model: null,
      reasoningEffort: null,
      fastMode: false,
    });
    await settings.rememberAgentConfig({
      provider: 'claude',
      model: 'recent',
      reasoningEffort: 'high',
      fastMode: true,
    });
    expect(settings.getAgentProviderDefaults('claude')).toEqual({
      model: null,
      reasoningEffort: null,
      fastMode: false,
    });
  });
  it.each([
    '{',
    JSON.stringify({
      provider: 'unknown',
      model: 'm',
      reasoningEffort: null,
      fastMode: false,
    }),
    JSON.stringify({
      provider: 'codex',
      model: 'x'.repeat(1001),
      reasoningEffort: null,
      fastMode: false,
    }),
  ])(
    'ignores malformed persisted last configs (%s)',
    async (lastUsedAgentConfig) => {
      const { db } = createDbMock([{ id: 1, lastUsedAgentConfig }]);
      const settings = new SettingsService(db);
      await settings.onModuleInit();
      expect(settings.getInitialAgentProvider('claude')).toBe('claude');
      expect(settings.getAgentProviderDefaults('codex')).toEqual({
        model: null,
        reasoningEffort: null,
      });
      await expect(
        settings.rememberAgentConfig({ provider: 'unknown' }),
      ).rejects.toThrow('Invalid agent');
    },
  );
  it('appends presets without losing concurrent additions or changing existing startup defaults', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);
    const deep = {
      id: 'deep',
      name: 'Deep work',
      provider: 'codex',
      model: 'gpt',
      reasoningEffort: 'high',
      fastMode: false,
      isDefault: false,
    };
    service.addAgentModelPreset(deep);
    service.addAgentModelPreset({ ...deep, id: 'quick', name: 'Quick pass' });
    service.addAgentModelPreset(deep);
    expect(service.getAgentModelPresets().map((p) => p.id)).toEqual([
      'quick',
      'deep',
    ]);
    expect(
      JSON.parse(
        (getRows()[0] as { agentModelPresets: string }).agentModelPresets,
      ),
    ).toHaveLength(2);
    expect(service.getAgentProviderDefaults('codex')).toEqual({
      model: null,
      reasoningEffort: null,
    });
    expect(() =>
      service.addAgentModelPreset({
        ...deep,
        id: 'collision',
        name: 'DEEP WORK',
      }),
    ).toThrow('already exists');
    expect(() =>
      service.addAgentModelPreset({ ...deep, name: 'Different' }),
    ).toThrow('identity');
    expect(service.getAgentModelPresets()).toHaveLength(2);
  });
  it('saves a global preset default, preserves other harness defaults and restores the exact previous choice', async () => {
    const { db } = createDbMock();
    const settings = new SettingsService(db);
    settings.addAgentModelPreset({
      id: 'deep',
      name: 'Deep',
      provider: 'codex',
      model: 'gpt',
      reasoningEffort: 'high',
    });
    settings.addAgentModelPreset({
      id: 'quick',
      name: 'Quick',
      provider: 'codex',
      model: 'gpt',
      reasoningEffort: 'low',
    });
    const original = settings.getAgentPresetDefault();
    const changed = settings.setAgentPresetDefault('quick', original.revision);
    expect(changed.before).toEqual(original);
    expect((await settings.findOne()).defaultAgentProvider).toBe('codex');
    expect(settings.getAgentProviderDefaults('codex').reasoningEffort).toBe(
      'low',
    );
    expect(() =>
      settings.setAgentPresetDefault('deep', original.revision),
    ).toThrow('changed');
    settings.restoreAgentPresetDefault(changed.before, changed.after.revision);
    expect(settings.getAgentPresetDefault()).toEqual(original);
    expect(
      settings.getAgentProviderDefaults('codex').reasoningEffort,
    ).toBeNull();
  });
  it('creates a default atomically and rejects stale Undo after another settings edit', () => {
    const { db } = createDbMock();
    const settings = new SettingsService(db);
    const before = settings.getAgentPresetDefault();
    const change = settings.addAgentModelPreset(
      {
        id: 'review',
        name: 'Review',
        provider: 'codex',
        model: 'gpt',
        reasoningEffort: 'high',
      },
      true,
      before.revision,
    )!;
    expect(change.before).toEqual(before);
    expect(settings.getAgentPresetDefault().id).toBe('review');
    settings.addAgentModelPreset({
      id: 'new',
      name: 'Another',
      provider: 'claude',
      model: null,
      reasoningEffort: null,
    });
    expect(() =>
      settings.restoreAgentPresetDefault(change.before, change.after.revision),
    ).toThrow('changed');
    expect(settings.getAgentPresetDefault().id).toBe('review');
    expect(settings.getAgentModelPresets()).toHaveLength(2);
  });
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of SPEECH_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
  });

  it('returns default settings before the singleton row exists', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(service.findOne()).resolves.toEqual({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      defaultModelByProvider: {},
      defaultReasoningEffortByProvider: {},
      agentModelPresets: [],
      maxWorktreesPerRepo: DEFAULT_MAX_WORKTREES_PER_REPO,
      runTimeLimitHours: 0,
      speechToText: DEFAULT_SPEECH_TO_TEXT_SETTINGS,
      speechToTextApiKeyConfigured: false,
      speechToTextApiKeyFromEnv: false,
      // Dictation defaults to the on-device engine, which needs no key.
      speechToTextRequiresApiKey: false,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it('defaults dictation to a local model so it works without any key', () => {
    expect(DEFAULT_SPEECH_TO_TEXT_SETTINGS.provider).toBe('local-whisper');
    expect(DEFAULT_SPEECH_TO_TEXT_SETTINGS.localModel).toBe('small');
  });

  it('creates and returns the singleton settings row', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    const settings = await service.update({
      defaultClaudeSessionSurface: 'tui',
    });

    expect(settings.defaultClaudeSessionSurface).toBe('tui');
    expect(settings.defaultAgentProvider).toBe('claude');
    expect(settings.sessionToolbarButtons).toBeNull();
    expect(settings.onboardingCompletedAt).toBeNull();
    expect(settings.createdAt).toEqual(expect.any(String));
    expect(settings.updatedAt).toEqual(expect.any(String));
    expect(getRows()).toHaveLength(1);
    expect(getRows()[0]).toMatchObject({
      id: 1,
      defaultClaudeSessionSurface: 'tui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
    });
  });

  it('updates the singleton row instead of inserting duplicates', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update({ defaultClaudeSessionSurface: 'tui' });
    await service.update({ defaultClaudeSessionSurface: 'claude-ui' });

    expect(getRows()).toHaveLength(1);
    expect(getRows()[0]).toMatchObject({
      id: 1,
      defaultClaudeSessionSurface: 'claude-ui',
    });
  });

  it('preserves existing settings during partial updates', async () => {
    const { db } = createDbMock([
      {
        id: 1,
        defaultClaudeSessionSurface: 'tui',
        defaultAgentProvider: 'codex',
        sessionToolbarButtons: JSON.stringify([
          { id: 'terminal', visible: false },
        ]),
        onboardingCompletedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsService(db);

    const settings = await service.update({
      sessionToolbarButtons: [{ id: 'files', visible: true }],
    });

    expect(settings.defaultClaudeSessionSurface).toBe('tui');
    expect(settings.defaultAgentProvider).toBe('codex');
    expect(settings.sessionToolbarButtons).toEqual([
      { id: 'files', visible: true },
    ]);
  });

  it('updates the default agent provider', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    const settings = await service.update({ defaultAgentProvider: 'pi' });

    expect(settings.defaultAgentProvider).toBe('pi');
    expect(getRows()[0]).toMatchObject({
      defaultAgentProvider: 'pi',
    });
  });

  it('resets session toolbar buttons when null is saved', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update({
      sessionToolbarButtons: [{ id: 'terminal', visible: false }],
    });
    const settings = await service.update({ sessionToolbarButtons: null });

    expect(settings.sessionToolbarButtons).toBeNull();
    expect(getRows()[0]).toMatchObject({
      sessionToolbarButtons: null,
    });
  });

  it('rejects unsupported Claude session surfaces', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(
      service.update({
        defaultClaudeSessionSurface: 'terminal',
      } as Parameters<SettingsService['update']>[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unsupported default agent providers', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(
      service.update({
        defaultAgentProvider: 'unknown-agent',
      } as Parameters<SettingsService['update']>[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('speech-to-text settings', () => {
    it('never exposes the API key through the settings API', async () => {
      const { db, getRows } = createDbMock();
      const service = new SettingsService(db);

      await service.update({ speechToTextApiKey: 'sk-super-secret' });

      // Stored...
      expect(getRows()[0]).toMatchObject({
        speechToTextApiKey: 'sk-super-secret',
      });

      // ...but absent from every read path the controller can return.
      const settings = await service.findOne();
      expect(settings).not.toHaveProperty('speechToTextApiKey');
      expect(JSON.stringify(settings)).not.toContain('sk-super-secret');
      expect(settings.speechToTextApiKeyConfigured).toBe(true);
      expect(settings.speechToTextApiKeyFromEnv).toBe(false);
    });

    it('keeps the stored key when the patch omits it and clears it on empty string', async () => {
      const { db, getRows } = createDbMock();
      const service = new SettingsService(db);

      await service.update({ speechToTextApiKey: 'sk-keep-me' });
      await service.update({ speechToText: { enabled: true } });
      expect(getRows()[0]).toMatchObject({ speechToTextApiKey: 'sk-keep-me' });

      await service.update({ speechToTextApiKey: '' });
      expect(getRows()[0]).toMatchObject({ speechToTextApiKey: null });
      await expect(service.findOne()).resolves.toMatchObject({
        speechToTextApiKeyConfigured: false,
      });
    });

    it('prefers an environment key and reports where it came from', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);
      // Environment keys are looked up per provider; the local engine has none,
      // so this has to be on a provider that authenticates.
      await service.update({
        speechToText: { provider: 'elevenlabs' },
        speechToTextApiKey: 'sk-from-db',
      });

      process.env.ELEVENEX_STT_API_KEY = 'sk-from-env';

      await expect(service.findOne()).resolves.toMatchObject({
        speechToTextApiKeyConfigured: true,
        speechToTextApiKeyFromEnv: true,
      });
      await expect(service.getSpeechToTextConfig()).resolves.toMatchObject({
        apiKey: 'sk-from-env',
        apiKeyFromEnv: true,
      });
    });

    it('falls back to the stored key when no environment key is set', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);
      await service.update({ speechToTextApiKey: 'sk-from-db' });

      await expect(service.getSpeechToTextConfig()).resolves.toMatchObject({
        apiKey: 'sk-from-db',
        apiKeyFromEnv: false,
      });
    });

    it('merges partial patches without clobbering other fields', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await service.update({
        speechToText: { enabled: true, provider: 'openrouter' },
      });
      const settings = await service.update({
        speechToText: { autoSend: true },
      });

      expect(settings.speechToText).toEqual({
        ...DEFAULT_SPEECH_TO_TEXT_SETTINGS,
        enabled: true,
        provider: 'openrouter',
        autoSend: true,
      });
    });

    it('rejects unsupported providers, cleanup modes and base URLs', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await expect(
        service.update({ speechToText: { provider: 'deepgram' } } as Parameters<
          SettingsService['update']
        >[0]),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.update({
          speechToText: { cleanupMode: 'magic' },
        } as Parameters<SettingsService['update']>[0]),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.update({ speechToText: { baseUrl: 'ftp://nope' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('keeps the dictation languages in the order they were picked', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      const settings = await service.update({
        // Order is meaningful: the first is the fallback when detection is
        // inconclusive, so it must not be sorted or deduplicated away.
        speechToText: { languages: ['fr', 'en', 'fr'] },
      });

      expect(settings.speechToText.languages).toEqual(['fr', 'en']);
    });

    it('rejects malformed or oversized language sets', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await expect(
        service.update({ speechToText: { languages: ['francais'] } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.update({
          speechToText: { languages: [42] } as Parameters<
            SettingsService['update']
          >[0]['speechToText'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.update({
          speechToText: { languages: ['en', 'fr', 'de', 'es', 'it', 'ja'] },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reads a row written before languages were a set', async () => {
      const { db } = createDbMock([
        {
          id: 1,
          defaultClaudeSessionSurface: 'claude-ui',
          defaultAgentProvider: 'claude',
          // The single-language shape, which is what every existing install
          // has on disk until the user next saves.
          speechToText: JSON.stringify({ enabled: true, language: 'fr' }),
        },
      ]);
      const service = new SettingsService(db);

      const settings = await service.findOne();
      expect(settings.speechToText.languages).toEqual(['fr']);
    });

    it('reads a legacy row that never pinned a language', async () => {
      const { db } = createDbMock([
        {
          id: 1,
          defaultClaudeSessionSurface: 'claude-ui',
          defaultAgentProvider: 'claude',
          speechToText: JSON.stringify({ enabled: true, language: null }),
        },
      ]);
      const service = new SettingsService(db);

      const settings = await service.findOne();
      expect(settings.speechToText.languages).toEqual([]);
    });

    it('falls back to defaults for a hand-edited settings row', async () => {
      const { db } = createDbMock([
        {
          id: 1,
          defaultClaudeSessionSurface: 'claude-ui',
          defaultAgentProvider: 'claude',
          speechToText: '{not json',
        },
      ]);
      const service = new SettingsService(db);

      await expect(service.findOne()).resolves.toMatchObject({
        speechToText: DEFAULT_SPEECH_TO_TEXT_SETTINGS,
      });
    });
  });

  it('completes onboarding with Claude surface and timestamp', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    const settings = await service.completeOnboarding({
      defaultAgentProvider: 'claude',
      defaultClaudeSessionSurface: 'tui',
    });

    expect(settings.defaultAgentProvider).toBe('claude');
    expect(settings.defaultClaudeSessionSurface).toBe('tui');
    expect(settings.onboardingCompletedAt).toEqual(expect.any(String));
    expect(getRows()[0]).toMatchObject({
      defaultAgentProvider: 'claude',
      defaultClaudeSessionSurface: 'tui',
      onboardingCompletedAt: expect.any(String),
    });
  });

  it('preserves Claude surface when onboarding completes with a non-Claude agent', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await service.update({ defaultClaudeSessionSurface: 'tui' });
    const settings = await service.completeOnboarding({
      defaultAgentProvider: 'codex',
      defaultClaudeSessionSurface: 'claude-ui',
    });

    expect(settings.defaultAgentProvider).toBe('codex');
    expect(settings.defaultClaudeSessionSurface).toBe('tui');
    expect(settings.onboardingCompletedAt).toEqual(expect.any(String));
  });

  it('patches one provider default without touching the others', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update({
      defaultModelByProvider: { claude: 'opus', codex: 'gpt-5.5' },
      defaultReasoningEffortByProvider: { claude: 'high' },
    });
    const settings = await service.update({
      defaultModelByProvider: { codex: 'gpt-5.4' },
    });

    expect(settings.defaultModelByProvider).toEqual({
      claude: 'opus',
      codex: 'gpt-5.4',
    });
    expect(settings.defaultReasoningEffortByProvider).toEqual({
      claude: 'high',
    });
    expect(getRows()[0]).toMatchObject({
      defaultModelByProvider: JSON.stringify({
        claude: 'opus',
        codex: 'gpt-5.4',
      }),
    });
  });

  it('clears a single provider default when its value is null', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update({
      defaultModelByProvider: { claude: 'opus', pi: 'pi-fast' },
    });
    const settings = await service.update({
      defaultModelByProvider: { claude: null },
    });

    expect(settings.defaultModelByProvider).toEqual({ pi: 'pi-fast' });
    expect(getRows()[0]).toMatchObject({
      defaultModelByProvider: JSON.stringify({ pi: 'pi-fast' }),
    });
  });

  it('stores no row value once every provider default is cleared', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update({ defaultReasoningEffortByProvider: { pi: 'high' } });
    const settings = await service.update({
      defaultReasoningEffortByProvider: null,
    });

    expect(settings.defaultReasoningEffortByProvider).toEqual({});
    expect(getRows()[0]).toMatchObject({
      defaultReasoningEffortByProvider: null,
    });
  });

  it('accepts providers and model ids it has never seen before', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    const settings = await service.update({
      defaultModelByProvider: { opencode: 'some-model-released-tomorrow' },
    });

    expect(settings.defaultModelByProvider).toEqual({
      opencode: 'some-model-released-tomorrow',
    });
  });

  it('stores ordered quick-launch model presets', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);
    const presets = [
      {
        id: 'fast-fixes',
        name: 'Fast fixes',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'low',
      },
      {
        id: 'deep-review',
        name: 'Deep review',
        provider: 'claude',
        model: 'opus',
        reasoningEffort: 'high',
      },
    ];

    const settings = await service.update({ agentModelPresets: presets });

    expect(settings.agentModelPresets).toEqual(presets);
    expect(getRows()[0]).toMatchObject({
      agentModelPresets: JSON.stringify(presets),
    });
  });

  it('uses preset defaults at startup and resets them after deletion', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);
    await service.update({ defaultModelByProvider: { codex: 'old-model' } });
    const migrated = await service.findOne();
    expect(migrated.agentModelPresets).toContainEqual(
      expect.objectContaining({
        provider: 'codex',
        model: 'old-model',
        isDefault: true,
      }),
    );
    await service.update({
      agentModelPresets: [
        {
          id: 'fast',
          name: 'Fast',
          provider: 'codex',
          model: 'gpt-5.5',
          reasoningEffort: 'low',
          fastMode: true,
          isDefault: true,
        },
      ],
    });
    expect(service.getAgentProviderDefaults('codex')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'low',
      fastMode: true,
    });
    await service.update({ agentModelPresets: [] });
    expect(service.getAgentProviderDefaults('codex')).toEqual({
      model: null,
      reasoningEffort: null,
    });
  });

  it('accepts deleting a default through request validation while other defaults remain', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);
    const current = await service.update({
      defaultModelByProvider: { claude: 'opus', codex: 'gpt-5.5' },
    });
    const remaining = current.agentModelPresets.filter(
      (preset) => preset.provider !== 'claude',
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ isDefault: true, fastMode: false });

    const patch = await new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }).transform(
      { agentModelPresets: remaining },
      { type: 'body', metatype: UpdateAppSettingsDto },
    );
    const settings = await service.update(patch);

    expect(settings.agentModelPresets).toEqual(remaining);
    expect(settings.defaultModelByProvider).toEqual({});
    expect(service.getAgentProviderDefaults('claude')).toEqual({
      model: null,
      reasoningEffort: null,
    });
    expect(service.getAgentProviderDefaults('codex')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: null,
      fastMode: false,
    });
    expect((await service.findOne()).agentModelPresets).toEqual(remaining);
  });

  it.each([true, false, undefined])(
    'accepts preset flags set to %s through request validation',
    async (flag) => {
      const { db } = createDbMock();
      const service = new SettingsService(db);
      const preset = {
        id: 'fast',
        name: 'Fast',
        provider: 'codex',
        model: null,
        reasoningEffort: null,
        ...(flag === undefined ? {} : { fastMode: flag, isDefault: flag }),
      };
      const patch = await new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }).transform(
        { agentModelPresets: [preset] },
        { type: 'body', metatype: UpdateAppSettingsDto },
      );

      expect((await service.update(patch)).agentModelPresets).toEqual([preset]);
    },
  );

  it.each(['fastMode', 'isDefault', 'unknownFlag'])(
    'rejects invalid preset field %s through request validation',
    async (field) => {
      await expect(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }).transform(
          {
            agentModelPresets: [
              {
                id: 'fast',
                name: 'Fast',
                provider: 'codex',
                model: null,
                reasoningEffort: null,
                [field]: 'true',
              },
            ],
          },
          { type: 'body', metatype: UpdateAppSettingsDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('keeps cached defaults unchanged when a legacy preference update is rejected', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);
    await service.update({
      agentModelPresets: [
        {
          id: 'default',
          name: 'Default',
          provider: 'codex',
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          isDefault: true,
        },
      ],
    });
    await expect(
      service.update({
        defaultModelByProvider: { codex: 'other' },
        maxWorktreesPerRepo: -1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.getAgentProviderDefaults('codex').model).toBe('gpt-5.5');
  });

  it('rejects invalid preset flags and multiple defaults for the same agent', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);
    const preset = {
      id: 'fast',
      name: 'Fast',
      provider: 'codex',
      model: null,
      reasoningEffort: null,
      isDefault: true,
    };
    await expect(
      service.update({
        agentModelPresets: [preset, { ...preset, id: 'other' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({
        agentModelPresets: [
          { ...preset, fastMode: 'yes' as unknown as boolean },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malformed or duplicate model presets', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);
    const preset = {
      id: 'same-id',
      name: 'Useful preset',
      provider: 'codex',
      model: null,
      reasoningEffort: null,
    };

    await expect(
      service.update({ agentModelPresets: [preset, preset] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({ agentModelPresets: [{ ...preset, name: ' ' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects malformed provider default entries', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(
      service.update({
        defaultModelByProvider: { 'not a provider id': 'opus' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({
        defaultModelByProvider: { claude: 42 },
      } as unknown as Parameters<SettingsService['update']>[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({
        defaultModelByProvider: { claude: 'x'.repeat(201) },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exposes per-provider defaults synchronously once loaded', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    expect(service.getAgentProviderDefaults('claude')).toEqual({
      model: null,
      reasoningEffort: null,
    });

    await service.update({
      defaultModelByProvider: { claude: 'opus' },
      defaultReasoningEffortByProvider: { claude: 'xhigh' },
    });

    expect(service.getAgentProviderDefaults('claude')).toEqual({
      model: 'opus',
      reasoningEffort: 'xhigh',
      fastMode: false,
    });
    expect(service.getAgentProviderDefaults('codex')).toEqual({
      model: null,
      reasoningEffort: null,
    });
  });

  it('drops unusable stored provider defaults instead of failing', async () => {
    const { db } = createDbMock([
      {
        id: 1,
        defaultClaudeSessionSurface: 'claude-ui',
        defaultAgentProvider: 'claude',
        sessionToolbarButtons: null,
        defaultModelByProvider: '{"claude":"opus","bad key":"x","pi":7}',
        defaultReasoningEffortByProvider: 'not json',
        onboardingCompletedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsService(db);

    const settings = await service.findOne();

    expect(settings.defaultModelByProvider).toEqual({ claude: 'opus' });
    expect(settings.defaultReasoningEffortByProvider).toEqual({});
  });

  it('preserves provider defaults through onboarding', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await service.update({ defaultModelByProvider: { claude: 'opus' } });
    const settings = await service.completeOnboarding({
      defaultAgentProvider: 'claude',
    });

    expect(settings.defaultModelByProvider).toEqual({ claude: 'opus' });
  });

  it('rejects unsupported session toolbar settings', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(
      service.update({
        sessionToolbarButtons: [{ id: 'terminal' }],
      } as Parameters<SettingsService['update']>[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('run time limit', () => {
    it('persists fractional hours, warms the runtime cache, and preserves the value on unrelated updates', async () => {
      const { db, getRows } = createDbMock();
      const service = new SettingsService(db);
      expect(service.getRunTimeLimitHours()).toBe(0);
      await service.update({ runTimeLimitHours: 0.5 });
      expect(getRows()[0]).toMatchObject({ runTimeLimitHours: 0.5 });
      expect(service.getRunTimeLimitHours()).toBe(0.5);
      await service.update({ defaultAgentProvider: 'codex' });
      await service.completeOnboarding({ defaultAgentProvider: 'claude' });
      const restarted = new SettingsService(db);
      await restarted.onModuleInit();
      expect(restarted.getRunTimeLimitHours()).toBe(0.5);
      await expect(
        service.update({ runTimeLimitHours: 0 }),
      ).resolves.toMatchObject({ runTimeLimitHours: 0 });
    });

    it.each([-1, 169, NaN, Infinity, null, '1'])(
      'rejects an invalid runtime limit %s',
      async (value) => {
        const { db } = createDbMock();
        const service = new SettingsService(db);
        await expect(
          service.update({ runTimeLimitHours: value as number }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('validates limits at the API boundary', async () => {
      const pipe = new ValidationPipe({ transform: true, whitelist: true });
      const metadata = {
        type: 'body' as const,
        metatype: UpdateAppSettingsDto,
      };
      await expect(
        pipe.transform({ runTimeLimitHours: 0.5 }, metadata),
      ).resolves.toMatchObject({ runTimeLimitHours: 0.5 });
      for (const value of [-1, 169, '1']) {
        await expect(
          pipe.transform({ runTimeLimitHours: value }, metadata),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('tolerates old or malformed stored settings', async () => {
      const { db } = createDbMock([{ id: 1, runTimeLimitHours: -1 }]);
      await expect(new SettingsService(db).findOne()).resolves.toMatchObject({
        runTimeLimitHours: 0,
      });
    });
  });

  describe('worktree limit', () => {
    it('stores a new limit and reads it back', async () => {
      const { db, getRows } = createDbMock();
      const service = new SettingsService(db);

      const settings = await service.update({ maxWorktreesPerRepo: 12 });

      expect(settings.maxWorktreesPerRepo).toBe(12);
      expect(getRows()[0]).toMatchObject({ maxWorktreesPerRepo: 12 });
      await expect(service.getMaxWorktreesPerRepo()).resolves.toBe(12);
    });

    it('accepts 0 as "no limit"', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await expect(
        service.update({ maxWorktreesPerRepo: 0 }),
      ).resolves.toMatchObject({ maxWorktreesPerRepo: 0 });
    });

    it('rejects negative, fractional and absurd limits', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      for (const value of [-1, 2.5, MAX_WORKTREES_PER_REPO_CEILING + 1]) {
        await expect(
          service.update({ maxWorktreesPerRepo: value }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('keeps the stored limit when another setting is patched', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await service.update({ maxWorktreesPerRepo: 3 });
      const settings = await service.update({ defaultAgentProvider: 'codex' });

      expect(settings.maxWorktreesPerRepo).toBe(3);
    });

    it('preserves the limit through onboarding', async () => {
      const { db } = createDbMock();
      const service = new SettingsService(db);

      await service.update({ maxWorktreesPerRepo: 2 });
      const settings = await service.completeOnboarding({
        defaultAgentProvider: 'claude',
      });

      expect(settings.maxWorktreesPerRepo).toBe(2);
    });

    it('falls back to the default for a hand-edited row', async () => {
      const { db } = createDbMock([
        { id: 1, maxWorktreesPerRepo: -7, createdAt: 'c', updatedAt: 'u' },
      ]);
      const service = new SettingsService(db);

      await expect(service.getMaxWorktreesPerRepo()).resolves.toBe(
        DEFAULT_MAX_WORKTREES_PER_REPO,
      );
    });
  });
});
