import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TodosService } from './todos.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { eq } from 'drizzle-orm';

describe('TodosService', () => {
  let service: TodosService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let projectId: number;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: SessionsService,
          useValue: {
            archiveAllByProject: jest.fn().mockResolvedValue(undefined),
          },
        },
        ProjectsService,
        TodosService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<TodosService>(TodosService);

    // Create a test project for all tests
    const result = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    projectId = result[0].id;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('create', () => {
    it('should create a todo with correct fields and completed=false', async () => {
      const result = await service.create(projectId, 'My todo');

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.projectId).toBe(projectId);
      expect(result.text).toBe('My todo');
      expect(result.completed).toBe(false);
      expect(result.sortOrder).toBe(0);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should append consecutive sort orders', async () => {
      await service.create(projectId, 'Todo 1');
      const todo2 = await service.create(projectId, 'Todo 2');
      const todo3 = await service.create(projectId, 'Todo 3');

      expect(todo2.sortOrder).toBe(1);
      expect(todo3.sortOrder).toBe(2);
    });

    it('should append after the maximum sort order following deletion', async () => {
      const first = await service.create(projectId, 'First');
      const second = await service.create(projectId, 'Second');
      const third = await service.create(projectId, 'Third');
      await service.delete(first.id);

      const created = await service.create(projectId, 'Appended');

      expect(created.sortOrder).toBe(3);
      expect(await service.findByProject(projectId)).toEqual([
        second,
        third,
        created,
      ]);
    });

    it('should append after sparse sort orders within the project', async () => {
      const todo = await service.create(projectId, 'Existing');
      await service.updateSortOrders(projectId, [
        { id: todo.id, sortOrder: 42 },
      ]);
      const otherProject = db
        .insert(schema.projects)
        .values({ name: 'Other project' })
        .returning()
        .get()!;
      db.insert(schema.todoItems)
        .values({ projectId: otherProject.id, text: 'Other', sortOrder: 100 })
        .run();

      expect((await service.create(projectId, 'Appended')).sortOrder).toBe(43);
    });

    it('should start an empty project at zero independently of other projects', async () => {
      const otherProject = db
        .insert(schema.projects)
        .values({ name: 'Other project' })
        .returning()
        .get()!;
      db.insert(schema.todoItems)
        .values({ projectId: otherProject.id, text: 'Other', sortOrder: 100 })
        .run();

      expect((await service.create(projectId, 'First')).sortOrder).toBe(0);
    });

    it('should allocate distinct sort orders for concurrent creates', async () => {
      const created = await Promise.all(
        ['First', 'Second', 'Third'].map((text) =>
          service.create(projectId, text),
        ),
      );

      expect(created.map((todo) => todo.sortOrder).sort()).toEqual([0, 1, 2]);
      expect(await service.findByProject(projectId)).toHaveLength(3);
    });
  });

  describe('findByProject', () => {
    it('should return all todos for a project sorted by sortOrder', async () => {
      await service.create(projectId, 'Todo A');
      await service.create(projectId, 'Todo B');
      await service.create(projectId, 'Todo C');

      // Update sort orders to test ordering
      await db
        .update(schema.todoItems)
        .set({ sortOrder: 2 })
        .where(eq(schema.todoItems.text, 'Todo A'));
      await db
        .update(schema.todoItems)
        .set({ sortOrder: 0 })
        .where(eq(schema.todoItems.text, 'Todo B'));
      await db
        .update(schema.todoItems)
        .set({ sortOrder: 1 })
        .where(eq(schema.todoItems.text, 'Todo C'));

      const results = await service.findByProject(projectId);

      expect(results).toHaveLength(3);
      expect(results[0].text).toBe('Todo B'); // sortOrder 0
      expect(results[1].text).toBe('Todo C'); // sortOrder 1
      expect(results[2].text).toBe('Todo A'); // sortOrder 2
    });

    it('should return empty array when no todos exist', async () => {
      const results = await service.findByProject(projectId);
      expect(results).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update todo fields', async () => {
      const todo = await service.create(projectId, 'Original text');

      const updated = await service.update(todo.id, {
        text: 'Updated text',
        completed: true,
      });

      expect(updated.text).toBe('Updated text');
      expect(updated.completed).toBe(true);
    });

    it('should allow partial updates', async () => {
      const todo = await service.create(projectId, 'Test todo');

      const updated = await service.update(todo.id, { completed: true });

      expect(updated.text).toBe('Test todo');
      expect(updated.completed).toBe(true);
    });

    it('should allow updating only text', async () => {
      const todo = await service.create(projectId, 'Test todo');
      await service.update(todo.id, { completed: true });

      const updated = await service.update(todo.id, { text: 'New text' });

      expect(updated.text).toBe('New text');
      expect(updated.completed).toBe(true);
    });
  });

  describe('updateSortOrders', () => {
    it('should update sortOrder for multiple todos', async () => {
      const t1 = await service.create(projectId, 'Todo 1');
      const t2 = await service.create(projectId, 'Todo 2');
      const t3 = await service.create(projectId, 'Todo 3');

      await service.updateSortOrders(projectId, [
        { id: t1.id, sortOrder: 2 },
        { id: t2.id, sortOrder: 0 },
        { id: t3.id, sortOrder: 1 },
      ]);

      const results = await service.findByProject(projectId);

      expect(results[0].id).toBe(t2.id);
      expect(results[1].id).toBe(t3.id);
      expect(results[2].id).toBe(t1.id);
    });

    it('should reorder a subset without changing omitted todos or normalizing orders', async () => {
      const first = await service.create(projectId, 'First');
      const omitted = await service.create(projectId, 'Omitted');
      const last = await service.create(projectId, 'Last');

      await service.updateSortOrders(projectId, [
        { id: first.id, sortOrder: 10 },
        { id: last.id, sortOrder: 8 },
      ]);

      expect(await service.findByProject(projectId)).toEqual([
        omitted,
        { ...last, sortOrder: 8 },
        { ...first, sortOrder: 10 },
      ]);
    });

    it('should accept an empty reorder as a no-op', async () => {
      const todo = await service.create(projectId, 'Unchanged');

      await service.updateSortOrders(projectId, []);

      expect(await service.findByProject(projectId)).toEqual([todo]);
    });

    it.each([null, '2026-01-01T00:00:00.000Z'])(
      'should reject IDs from another project (archivedAt=%s) before any changes',
      async (archivedAt) => {
        const own = await service.create(projectId, 'Own');
        const otherProject = db
          .insert(schema.projects)
          .values({ name: 'Other project', archivedAt })
          .returning()
          .get()!;
        const foreign = db
          .insert(schema.todoItems)
          .values({
            projectId: otherProject.id,
            text: 'Foreign',
            sortOrder: 50,
          })
          .returning()
          .get()!;
        const before = db.select().from(schema.todoItems).all();

        await expect(
          service.updateSortOrders(projectId, [
            { id: own.id, sortOrder: 10 },
            { id: foreign.id, sortOrder: 20 },
          ]),
        ).rejects.toThrow(NotFoundException);

        expect(db.select().from(schema.todoItems).all()).toEqual(before);
      },
    );

    it.each(['duplicate', 'missing'] as const)(
      'should reject a %s ID before issuing any ordering writes',
      async (invalid) => {
        const first = await service.create(projectId, 'First');
        const second = await service.create(projectId, 'Second');
        const before = db.select().from(schema.todoItems).all();
        sqlite.exec(`
          CREATE TRIGGER reject_ordering_write BEFORE UPDATE OF sort_order ON todo_items
          BEGIN SELECT RAISE(ABORT, 'unexpected ordering write'); END;
        `);

        await expect(
          service.updateSortOrders(projectId, [
            { id: first.id, sortOrder: 10 },
            { id: second.id, sortOrder: 20 },
            {
              id: invalid === 'duplicate' ? first.id : second.id + 1,
              sortOrder: 30,
            },
          ]),
        ).rejects.toThrow(
          invalid === 'duplicate' ? BadRequestException : NotFoundException,
        );

        expect(db.select().from(schema.todoItems).all()).toEqual(before);
      },
    );

    it('should roll back the entire batch when a later database write fails', async () => {
      const first = await service.create(projectId, 'First');
      const second = await service.create(projectId, 'Second');
      const before = db.select().from(schema.todoItems).all();
      sqlite.exec(`
        CREATE TRIGGER fail_reorder AFTER UPDATE OF sort_order ON todo_items
        WHEN NEW.id = ${second.id}
        BEGIN SELECT RAISE(ABORT, 'injected reorder failure'); END;
      `);

      await expect(
        service.updateSortOrders(projectId, [
          { id: first.id, sortOrder: 10 },
          { id: second.id, sortOrder: 20 },
        ]),
      ).rejects.toMatchObject({
        code: 'SQLITE_CONSTRAINT_TRIGGER',
        message: 'injected reorder failure',
      });

      expect(db.select().from(schema.todoItems).all()).toEqual(before);
      expect(sqlite.inTransaction).toBe(false);
    });

    it('should reject reordering an archived project', async () => {
      const todo = await service.create(projectId, 'Archived');
      db.update(schema.projects)
        .set({ archivedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(schema.projects.id, projectId))
        .run();

      await expect(
        service.updateSortOrders(projectId, [{ id: todo.id, sortOrder: 10 }]),
      ).rejects.toThrow(ConflictException);
      await expect(service.updateSortOrders(projectId, [])).rejects.toThrow(
        ConflictException,
      );

      expect(await service.findByProject(projectId)).toEqual([todo]);
    });

    it('should reject reordering a missing project', async () => {
      const todo = await service.create(projectId, 'Unchanged');

      await expect(
        service.updateSortOrders(projectId + 1, [
          { id: todo.id, sortOrder: 10 },
        ]),
      ).rejects.toThrow(NotFoundException);
      await expect(service.updateSortOrders(projectId + 1, [])).rejects.toThrow(
        NotFoundException,
      );

      expect(await service.findByProject(projectId)).toEqual([todo]);
    });
  });

  describe('delete', () => {
    it('should delete a todo', async () => {
      const todo = await service.create(projectId, 'To delete');

      await service.delete(todo.id);

      const results = await service.findByProject(projectId);
      expect(results).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent todo', async () => {
      await expect(service.delete(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('clearCompleted', () => {
    it('should delete all completed todos for project', async () => {
      const t1 = await service.create(projectId, 'Todo 1');
      const t2 = await service.create(projectId, 'Todo 2');
      const t3 = await service.create(projectId, 'Todo 3');

      // Mark some as completed
      await service.update(t1.id, { completed: true });
      await service.update(t3.id, { completed: true });

      const count = await service.clearCompleted(projectId);

      expect(count).toBe(2);

      const remaining = await service.findByProject(projectId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(t2.id);
    });

    it('should return 0 when no completed todos exist', async () => {
      await service.create(projectId, 'Todo 1');
      await service.create(projectId, 'Todo 2');

      const count = await service.clearCompleted(projectId);

      expect(count).toBe(0);

      const remaining = await service.findByProject(projectId);
      expect(remaining).toHaveLength(2);
    });
  });
});
