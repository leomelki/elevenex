import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { SessionsService } from './sessions.service.js';

@Injectable()
export class SessionFoldersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly sessions: SessionsService,
  ) {}

  listByRepo(repoId: number) {
    return this.db
      .select()
      .from(schema.sessionFolders)
      .where(eq(schema.sessionFolders.repoId, repoId));
  }

  async create(input: { repoId: number; workspaceId: number; name: string }) {
    const name = this.normalizedName(input.name);
    await this.assertWorkspace(input.repoId, input.workspaceId);
    const rows = await this.db
      .insert(schema.sessionFolders)
      .values({ ...input, name })
      .returning();
    return rows[0];
  }

  async groupSessions(input: { repoId: number; workspaceId: number; name: string; sessionIds: number[] }) {
    const name = this.normalizedName(input.name);
    await this.assertWorkspace(input.repoId, input.workspaceId);
    const sessionIds = [...new Set(input.sessionIds)];
    if (sessionIds.length !== 2 || sessionIds.some((id) => !Number.isInteger(id))) {
      throw new BadRequestException('Exactly two different sessions are required');
    }

    const sessions = await this.db
      .select({ id: schema.sessions.id, repoId: schema.sessions.repoId, workspaceId: schema.sessions.workspaceId, status: schema.sessions.status })
      .from(schema.sessions)
      .where(inArray(schema.sessions.id, sessionIds));
    if (
      sessions.length !== 2 ||
      sessions.some((session) => session.repoId !== input.repoId || session.workspaceId !== input.workspaceId || session.status === 'archived')
    ) {
      throw new BadRequestException('Sessions must be active and belong to this workspace');
    }

    return this.db.transaction((tx) => {
      const folder = tx.insert(schema.sessionFolders).values({ repoId: input.repoId, workspaceId: input.workspaceId, name }).returning().get();
      tx.update(schema.sessions).set({ folderId: folder.id, updatedAt: new Date().toISOString() }).where(inArray(schema.sessions.id, sessionIds)).run();
      return folder;
    });
  }

  async rename(id: number, rawName: string) {
    await this.findOne(id);
    const rows = await this.db
      .update(schema.sessionFolders)
      .set({
        name: this.normalizedName(rawName),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessionFolders.id, id))
      .returning();
    return rows[0];
  }

  async archive(id: number) {
    const folder = await this.findOne(id);
    if (folder.archivedAt) return folder;

    const sessions = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.folderId, id),
          ne(schema.sessions.status, 'archived'),
        ),
      );
    await Promise.all(
      sessions.map((session) => this.sessions.archiveAndStop(session.id)),
    );

    const now = new Date().toISOString();
    return this.db.transaction((tx) => {
      if (sessions.length > 0) {
        tx.update(schema.sessions)
          .set({ archivedByFolder: true, updatedAt: now })
          .where(
            inArray(
              schema.sessions.id,
              sessions.map((session) => session.id),
            ),
          )
          .run();
      }
      return tx
        .update(schema.sessionFolders)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(schema.sessionFolders.id, id))
        .returning()
        .get();
    });
  }

  async unarchive(id: number) {
    const folder = await this.findOne(id);
    if (!folder.archivedAt) return folder;
    const sessions = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.folderId, id),
          eq(schema.sessions.archivedByFolder, true),
        ),
      );

    const workspaces = await this.db
      .select({ linkStatus: schema.workspaces.linkStatus })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, folder.workspaceId));
    if (workspaces[0]?.linkStatus === 'unlinked') {
      throw new BadRequestException(
        'This workspace is unlinked from its worktree. Link it back before restoring sessions.',
      );
    }

    const now = new Date().toISOString();
    const restored = this.db.transaction((tx) => {
      if (sessions.length > 0) {
        tx.update(schema.sessions)
          .set({ status: 'stopped', archivedByFolder: false, updatedAt: now })
          .where(
            inArray(
              schema.sessions.id,
              sessions.map((session) => session.id),
            ),
          )
          .run();
      }
      return tx
        .update(schema.sessionFolders)
        .set({ archivedAt: null, updatedAt: now })
        .where(eq(schema.sessionFolders.id, id))
        .returning()
        .get();
    });
    for (const session of sessions) {
      this.sessions.emit('session-status-changed', {
        sessionId: session.id,
        status: 'stopped',
      });
    }
    return restored;
  }

  async delete(id: number) {
    const folder = await this.findOne(id);
    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.folderId, id));
    await this.sessions.deleteMany(rows.map((row) => row.id));
    await this.db
      .delete(schema.sessionFolders)
      .where(eq(schema.sessionFolders.id, id));
    return { ...folder, deletedSessionIds: rows.map((row) => row.id) };
  }

  private async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.sessionFolders)
      .where(eq(schema.sessionFolders.id, id));
    if (!rows[0])
      throw new NotFoundException(`Session folder with id ${id} not found`);
    return rows[0];
  }

  private async assertWorkspace(repoId: number, workspaceId: number) {
    const rows = await this.db
      .select({ repoId: schema.workspaces.repoId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
    if (!rows[0] || rows[0].repoId !== repoId) {
      throw new BadRequestException(
        'Workspace does not belong to this repository',
      );
    }
  }

  private normalizedName(name: string): string {
    const normalized = name.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new BadRequestException('Folder name is required');
    return normalized;
  }
}
