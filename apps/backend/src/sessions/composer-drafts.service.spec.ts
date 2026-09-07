import { NotFoundException } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import { ComposerDraftsService } from './composer-drafts.service.js';

const IMAGE = {
  id: 'img-1',
  name: 'screen.png',
  mediaType: 'image/png',
  dataUrl: 'data:image/png;base64,abc',
  size: 3,
};

describe('ComposerDraftsService', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let service: ComposerDraftsService;
  let sessionId: number;
  let otherSessionId: number;

  const createSession = async (repoId: number, branch: string) => {
    const rows = await db
      .insert(schema.sessions)
      .values({
        repoId,
        branchName: branch,
        worktreePath: `/tmp/test-repo/${branch}`,
      })
      .returning();
    return rows[0].id;
  };

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;
    service = new ComposerDraftsService(db);

    const projectRows = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    const repoRows = await db
      .insert(schema.repos)
      .values({
        projectId: projectRows[0].id,
        name: 'test-repo',
        path: '/tmp/test-repo',
      })
      .returning();

    sessionId = await createSession(repoRows[0].id, 'feature');
    otherSessionId = await createSession(repoRows[0].id, 'other');
  });

  afterEach(() => {
    sqliteConn.close();
  });

  it('round-trips a draft for the session that owns it', async () => {
    await service.save(sessionId, {
      text: 'Keep this draft',
      diffMentions: [{ id: 'mention-1' }],
      sessionMentions: [],
      images: [IMAGE],
    });

    await expect(service.find(sessionId)).resolves.toEqual({
      sessionId,
      text: 'Keep this draft',
      diffMentions: [{ id: 'mention-1' }],
      sessionMentions: [],
      images: [IMAGE],
      updatedAt: expect.any(String),
    });
    await expect(service.find(otherSessionId)).resolves.toBeNull();
  });

  it('refuses to store a draft for a session this database does not have', async () => {
    await expect(
      service.save(9_999, { text: 'nowhere', diffMentions: [] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.find(9_999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps stored attachments when the payload omits them', async () => {
    await service.save(sessionId, { text: 'with image', images: [IMAGE] });
    await service.save(sessionId, { text: 'with image, edited' });

    await expect(service.find(sessionId)).resolves.toMatchObject({
      text: 'with image, edited',
      images: [IMAGE],
    });

    await service.save(sessionId, { text: 'no image', images: [] });
    await expect(service.find(sessionId)).resolves.toMatchObject({ images: [] });
  });

  it('drops the row once the composer is empty', async () => {
    await service.save(sessionId, { text: 'Draft' });
    await expect(service.save(sessionId, { text: '   ' })).resolves.toBeNull();
    await expect(service.find(sessionId)).resolves.toBeNull();

    await service.save(sessionId, { text: 'Draft again' });
    await service.delete(sessionId);
    await expect(service.find(sessionId)).resolves.toBeNull();
  });

  it('drops attachments that would bloat the row but keeps the text', async () => {
    const huge = {
      ...IMAGE,
      dataUrl: `data:image/png;base64,${'a'.repeat(9 * 1024 * 1024)}`,
    };

    await service.save(sessionId, { text: 'Too much', images: [huge] });

    await expect(service.find(sessionId)).resolves.toMatchObject({
      text: 'Too much',
      images: [],
    });
  });

  it('dies with the session it belongs to', async () => {
    await service.save(sessionId, { text: 'Draft' });

    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));

    const rows = await db
      .select()
      .from(schema.composerDrafts)
      .where(eq(schema.composerDrafts.sessionId, sessionId));
    expect(rows).toEqual([]);
  });
});
