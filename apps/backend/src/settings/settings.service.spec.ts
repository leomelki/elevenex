import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import { SettingsService } from './settings.service.js';
import { DEFAULT_SPEECH_TO_TEXT_SETTINGS } from './settings.types.js';

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
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const onConflictDoUpdate = jest.fn(
    async ({ set }: { set: Record<string, unknown> }) => {
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
    },
  );
  const valuesMock = jest.fn(() => ({ onConflictDoUpdate }));
  const insert = jest.fn(() => ({ values: valuesMock }));

  return {
    db: { select, insert } as unknown as DrizzleDB,
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
        defaultAgentProvider: 'opencode',
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
});
