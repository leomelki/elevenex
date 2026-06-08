import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, asc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';

@Injectable()
export class ScratchpadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
  ) {}

  async create(projectId: number, name: string, description?: string) {
    await this.projectsService.assertProjectIsActive(projectId);

    // Get count of existing sections to assign sortOrder
    const existing = await this.db
      .select()
      .from(schema.scratchpadSections)
      .where(eq(schema.scratchpadSections.projectId, projectId));

    const rows = await this.db
      .insert(schema.scratchpadSections)
      .values({
        projectId,
        name,
        description: description ?? null,
        sortOrder: existing.length,
      })
      .returning();
    return rows[0];
  }

  async findByProject(projectId: number) {
    return this.db
      .select()
      .from(schema.scratchpadSections)
      .where(eq(schema.scratchpadSections.projectId, projectId))
      .orderBy(asc(schema.scratchpadSections.sortOrder));
  }

  async update(
    sectionId: number,
    data: Partial<{
      name: string;
      description: string | null;
      content: string;
      isMarkdown: boolean;
    }>,
  ) {
    const section = await this.findOne(sectionId);
    await this.projectsService.assertProjectIsActive(section.projectId);

    const rows = await this.db
      .update(schema.scratchpadSections)
      .set(data)
      .where(eq(schema.scratchpadSections.id, sectionId))
      .returning();
    return rows[0];
  }

  async updateSortOrders(
    projectId: number,
    orders: { id: number; sortOrder: number }[],
  ) {
    await this.projectsService.assertProjectIsActive(projectId);

    // Update each section's sort order
    for (const order of orders) {
      await this.db
        .update(schema.scratchpadSections)
        .set({ sortOrder: order.sortOrder })
        .where(eq(schema.scratchpadSections.id, order.id));
    }
  }

  async delete(sectionId: number) {
    const section = await this.findOne(sectionId);
    await this.projectsService.assertProjectIsActive(section.projectId);

    const rows = await this.db
      .delete(schema.scratchpadSections)
      .where(eq(schema.scratchpadSections.id, sectionId))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(
        `Scratchpad section with id ${sectionId} not found`,
      );
    }
    return rows[0];
  }

  private async findOne(sectionId: number) {
    const rows = await this.db
      .select()
      .from(schema.scratchpadSections)
      .where(eq(schema.scratchpadSections.id, sectionId));

    if (rows.length === 0) {
      throw new NotFoundException(
        `Scratchpad section with id ${sectionId} not found`,
      );
    }

    return rows[0];
  }
}
