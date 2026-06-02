import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  DEFAULT_BROWSER_ISOLATION_MODE,
  DEFAULT_BROWSER_ISOLATION_SHARED_GLOBS,
} from '../browser-isolation/browser-isolation.defaults.js';

export type ProjectListState = 'active' | 'archived' | 'all';

@Injectable()
export class ProjectsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findAll(state: ProjectListState = 'active') {
    if (state === 'all') {
      return this.db.select().from(schema.projects);
    }

    return this.db
      .select()
      .from(schema.projects)
      .where(
        state === 'archived'
          ? isNotNull(schema.projects.archivedAt)
          : isNull(schema.projects.archivedAt),
      );
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Project with id ${id} not found`);
    }
    return rows[0];
  }

  async create(name: string) {
    try {
      return this.db.transaction((tx) => {
        const rows = tx
          .insert(schema.projects)
          .values({ name })
          .returning()
          .all();
        const project = rows[0];

        tx.insert(schema.browserIsolationSettings)
          .values({
            projectId: project.id,
            mode: DEFAULT_BROWSER_ISOLATION_MODE,
            sharedGlobs: JSON.stringify(DEFAULT_BROWSER_ISOLATION_SHARED_GLOBS),
          })
          .run();

        return project;
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed')
      ) {
        throw new ConflictException('Project name already exists');
      }
      throw error;
    }
  }

  async archive(id: number) {
    const project = await this.findOne(id);
    if (project.archivedAt) {
      return project;
    }

    const timestamp = new Date().toISOString();
    const rows = await this.db
      .update(schema.projects)
      .set({
        archivedAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(schema.projects.id, id))
      .returning();

    return rows[0];
  }

  async unarchive(id: number) {
    const project = await this.findOne(id);
    if (!project.archivedAt) {
      return project;
    }

    const timestamp = new Date().toISOString();
    const rows = await this.db
      .update(schema.projects)
      .set({
        archivedAt: null,
        updatedAt: timestamp,
      })
      .where(eq(schema.projects.id, id))
      .returning();

    return rows[0];
  }

  async assertProjectIsActive(id: number) {
    const project = await this.findOne(id);
    if (project.archivedAt) {
      throw new ConflictException(
        'Archived projects are read-only. Restore the project before making changes.',
      );
    }
    return project;
  }

  parseListState(value: string | undefined): ProjectListState {
    if (value === undefined || value === '' || value === 'active') {
      return 'active';
    }
    if (value === 'archived' || value === 'all') {
      return value;
    }
    throw new BadRequestException('Project state must be active, archived, or all');
  }

  async delete(id: number) {
    const rows = await this.db
      .delete(schema.projects)
      .where(eq(schema.projects.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Project with id ${id} not found`);
    }
    return rows[0];
  }
}
