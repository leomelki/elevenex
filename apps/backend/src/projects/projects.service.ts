import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

@Injectable()
export class ProjectsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findAll() {
    return this.db.select().from(schema.projects);
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
      const rows = await this.db
        .insert(schema.projects)
        .values({ name })
        .returning();
      return rows[0];
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
