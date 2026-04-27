import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, count } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

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
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findByProject(projectId: number) {
    return this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.projectId, projectId));
  }

  async addRepo(projectId: number, repoPath: string) {
    if (!fs.existsSync(repoPath)) {
      throw new BadRequestException(
        'Folder not found. Verify the path exists and points to a git repository.',
      );
    }

    if (!fs.statSync(repoPath).isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      throw new BadRequestException(
        'Not a git repository. Verify the folder contains a .git directory.',
      );
    }

    const name = path.basename(repoPath);
    const color = await this.assignColor(projectId);

    try {
      const rows = await this.db
        .insert(schema.repos)
        .values({ projectId, name, path: repoPath, color })
        .returning();
      return rows[0];
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
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
    const usedColors = new Set(existingRepos.map(r => r.color).filter(Boolean));

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

  async remove(id: number) {
    const rows = await this.db
      .delete(schema.repos)
      .where(eq(schema.repos.id, id))
      .returning();

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

  async updatePreferredContextRootRef(id: number, preferredContextRootRef: string | null) {
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
}
