import { isSqliteUniqueConstraintError } from '../database/sqlite-errors.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, count, or, sql } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { assertTaskHistoryCanBeDeleted } from '../tasks/task-deletion-guard.js';

// Colorblind-safe palette (OKLCH-based perceptually distinct colors)
// These colors are distinguishable for protanopia, deuteranopia, and tritanopia
const REPO_COLORS = [
  '#2563eb', // Blue (primary-like)
  '#dc2626', // Red
  '#16a34a', // Green
  '#ea580c', // Orange
  '#7c3aed', // Violet
  '#0891b2', // Cyan
  '#db2777', // Pink
  '#65a30d', // Lime
  '#4f46e5', // Indigo
  '#0d9488', // Teal
] as const;

@Injectable()
export class ReposService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
  ) {}

  async findByProject(projectId: number) {
    return this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.projectId, projectId));
  }

  async validatePath(inputPath: string) {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      throw new BadRequestException('Choose a repository folder.');
    }
    const expanded =
      trimmed === '~'
        ? homedir()
        : /^~[\\/]/.test(trimmed)
          ? path.join(homedir(), trimmed.slice(2))
          : trimmed;
    const repoPath = path.resolve(expanded);
    let stat;
    try {
      stat = await fs.stat(repoPath);
    } catch {
      throw new BadRequestException(
        'Folder not found. Verify the path exists and points to a git repository.',
      );
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    try {
      await fs.access(path.join(repoPath, '.git'));
    } catch {
      throw new BadRequestException(
        'Not a git repository. Choose the root folder of a Git repository.',
      );
    }

    return { name: path.basename(repoPath), path: repoPath };
  }

  async suggestRepositories(query = '', limit = 20) {
    // Search saved metadata only: opening the picker must not scan repositories
    // or launch git processes. Group paths shared by multiple projects.
    const term = query.trim();
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db
      .select({
        name: sql<string>`max(${schema.repos.name})`,
        path: schema.repos.path,
      })
      .from(schema.repos)
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.repos.projectId),
      )
      .where(
        and(
          eq(schema.projects.hidden, false),
          term
            ? or(
                sql`${schema.repos.name} like ${pattern} escape '\\'`,
                sql`${schema.repos.path} like ${pattern} escape '\\'`,
              )
            : undefined,
        ),
      )
      .groupBy(schema.repos.path)
      .orderBy(desc(sql`max(${schema.repos.id})`))
      .limit(Math.max(1, Math.min(50, limit)));
  }

  async addRepo(projectId: number, inputPath: string) {
    await this.projectsService.assertProjectIsActive(projectId);
    const { name, path: repoPath } = await this.validatePath(inputPath);
    const color = await this.assignColor(projectId);

    try {
      const rows = await this.db
        .insert(schema.repos)
        .values({ projectId, name, path: repoPath, color })
        .returning();
      return rows[0];
    } catch (error: unknown) {
      if (isSqliteUniqueConstraintError(error)) {
        throw new ConflictException(
          'This folder is already added to this project.',
        );
      }
      throw error;
    }
  }

  /**
   * Assign a color to a new repo based on existing repo colors in the project.
   * Uses round-robin assignment from a colorblind-safe palette.
   */
  private async assignColor(projectId: number): Promise<string> {
    const existingRepos = await this.findByProject(projectId);
    const usedColors = new Set(
      existingRepos.map((r) => r.color).filter(Boolean),
    );

    // Find first unused color
    for (const color of REPO_COLORS) {
      if (!usedColors.has(color)) {
        return color;
      }
    }

    // All colors used, cycle through them based on count
    const index = existingRepos.length % REPO_COLORS.length;
    return REPO_COLORS[index];
  }

  assertTaskHistoryCanBeDeleted(id: number) {
    assertTaskHistoryCanBeDeleted(this.db, { repoId: id });
  }

  async remove(id: number, options: { requireFinishedTasks?: boolean } = {}) {
    const repo = await this.findOne(id);
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const rows = this.db.transaction((tx) => {
      if (options.requireFinishedTasks)
        assertTaskHistoryCanBeDeleted(tx, { repoId: id });
      return tx
        .delete(schema.repos)
        .where(eq(schema.repos.id, id))
        .returning()
        .all();
    });

    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }
    return rows[0];
  }

  async countByProject(projectId: number) {
    const result = await this.db
      .select({ count: count() })
      .from(schema.repos)
      .where(eq(schema.repos.projectId, projectId));
    return result[0].count;
  }

  async updatePreferredContextRootRef(
    id: number,
    preferredContextRootRef: string | null,
  ) {
    const repo = await this.findOne(id);
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const rows = await this.db
      .update(schema.repos)
      .set({
        preferredContextRootRef: preferredContextRootRef?.trim() || null,
      })
      .where(eq(schema.repos.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    return rows[0];
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    return rows[0];
  }
}
