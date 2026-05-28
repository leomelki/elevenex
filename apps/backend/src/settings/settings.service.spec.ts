import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import { SettingsService } from './settings.service.js';

function createDbMock(initialRows: unknown[] = []) {
  let rows = [...initialRows];
  const limit = jest.fn(async () => rows);
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const onConflictDoUpdate = jest.fn(async ({ set }: { set: Record<string, unknown> }) => {
    const values = valuesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const index = rows.findIndex((row) => (
      typeof row === 'object' &&
      row !== null &&
      'id' in row &&
      (row as { id: unknown }).id === values.id
    ));

    if (index === -1) {
      rows.push(values);
    } else {
      rows[index] = {
        ...(rows[index] as Record<string, unknown>),
        ...set,
      };
    }
  });
  const valuesMock = jest.fn(() => ({ onConflictDoUpdate }));
  const insert = jest.fn(() => ({ values: valuesMock }));

  return {
    db: { select, insert } as unknown as DrizzleDB,
    getRows: () => rows,
    mocks: { select, from, where, limit, insert, values: valuesMock, onConflictDoUpdate },
  };
}

describe('SettingsService', () => {
  it('returns default settings before the singleton row exists', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(service.findOne()).resolves.toEqual({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });
  });

  it('creates and returns the singleton settings row', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    const settings = await service.update('tui');

    expect(settings.defaultClaudeSessionSurface).toBe('tui');
    expect(settings.createdAt).toEqual(expect.any(String));
    expect(settings.updatedAt).toEqual(expect.any(String));
    expect(getRows()).toHaveLength(1);
    expect(getRows()[0]).toMatchObject({
      id: 1,
      defaultClaudeSessionSurface: 'tui',
    });
  });

  it('updates the singleton row instead of inserting duplicates', async () => {
    const { db, getRows } = createDbMock();
    const service = new SettingsService(db);

    await service.update('tui');
    await service.update('claude-ui');

    expect(getRows()).toHaveLength(1);
    expect(getRows()[0]).toMatchObject({
      id: 1,
      defaultClaudeSessionSurface: 'claude-ui',
    });
  });

  it('rejects unsupported Claude session surfaces', async () => {
    const { db } = createDbMock();
    const service = new SettingsService(db);

    await expect(
      service.update('terminal' as Parameters<SettingsService['update']>[0]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
