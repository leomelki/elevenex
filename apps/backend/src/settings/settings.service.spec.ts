import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import { SettingsService } from './settings.service.js';

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
  it('returns default settings before the singleton row exists', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(service.findOne()).resolves.toEqual({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });
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
