import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, asc, and, count } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';

@Injectable()
export class TodosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
  ) {}

  async create(projectId: number, text: string) {
    await this.projectsService.assertProjectIsActive(projectId);

    // Get count of existing todos to assign sortOrder
    const existing = await this.db
      .select()
      .from(schema.todoItems)
      .where(eq(schema.todoItems.projectId, projectId));

    const rows = await this.db
      .insert(schema.todoItems)
      .values({
        projectId,
        text,
        sortOrder: existing.length,
      })
      .returning();
    return rows[0];
  }

  async findByProject(projectId: number) {
    return this.db
      .select()
      .from(schema.todoItems)
      .where(eq(schema.todoItems.projectId, projectId))
      .orderBy(asc(schema.todoItems.sortOrder));
  }

  async listHandles(
    projectId: number,
    state: 'open' | 'completed' | 'all',
    offset = 0,
    limit = 25,
  ) {
    const where = and(
      eq(schema.todoItems.projectId, projectId),
      state === 'all'
        ? undefined
        : eq(schema.todoItems.completed, state === 'completed'),
    );
    return Promise.resolve(
      this.db.transaction((tx) => {
        const total = tx
          .select({ value: count() })
          .from(schema.todoItems)
          .where(where)
          .get()!.value;
        const todos = tx
          .select({
            todoId: schema.todoItems.id,
            text: schema.todoItems.text,
            completed: schema.todoItems.completed,
          })
          .from(schema.todoItems)
          .where(where)
          .orderBy(asc(schema.todoItems.sortOrder), asc(schema.todoItems.id))
          .limit(Math.min(100, Math.max(1, limit)))
          .offset(Math.max(0, offset))
          .all();
        return {
          todos,
          total,
          nextOffset:
            offset + todos.length < total ? offset + todos.length : null,
        };
      }),
    );
  }

  async update(
    todoId: number,
    data: Partial<{ text: string; completed: boolean }>,
  ) {
    const todo = await this.findOne(todoId);
    await this.projectsService.assertProjectIsActive(todo.projectId);

    const rows = await this.db
      .update(schema.todoItems)
      .set(data)
      .where(eq(schema.todoItems.id, todoId))
      .returning();
    return rows[0];
  }

  async updateSortOrders(
    projectId: number,
    orders: { id: number; sortOrder: number }[],
  ) {
    await this.projectsService.assertProjectIsActive(projectId);

    // Update each todo's sort order
    for (const order of orders) {
      await this.db
        .update(schema.todoItems)
        .set({ sortOrder: order.sortOrder })
        .where(eq(schema.todoItems.id, order.id));
    }
  }

  async delete(todoId: number) {
    const todo = await this.findOne(todoId);
    await this.projectsService.assertProjectIsActive(todo.projectId);

    const rows = await this.db
      .delete(schema.todoItems)
      .where(eq(schema.todoItems.id, todoId))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException(`Todo with id ${todoId} not found`);
    }
    return rows[0];
  }

  async clearCompleted(projectId: number) {
    await this.projectsService.assertProjectIsActive(projectId);

    const rows = await this.db
      .delete(schema.todoItems)
      .where(
        and(
          eq(schema.todoItems.projectId, projectId),
          eq(schema.todoItems.completed, true),
        ),
      )
      .returning();

    return rows.length;
  }

  private async findOne(todoId: number) {
    const rows = await this.db
      .select()
      .from(schema.todoItems)
      .where(eq(schema.todoItems.id, todoId));

    if (rows.length === 0) {
      throw new NotFoundException(`Todo with id ${todoId} not found`);
    }

    return rows[0];
  }
}
