import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TodosService } from './todos.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { eq } from 'drizzle-orm';

function createTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

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
        TodosService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<TodosService>(TodosService);

    // Create a test project for all tests
    const result = await db.insert(schema.projects).values({ name: 'Test Project' }).returning();
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

    it('should assign sortOrder based on existing todos count', async () => {
      await service.create(projectId, 'Todo 1');
      const todo2 = await service.create(projectId, 'Todo 2');
      const todo3 = await service.create(projectId, 'Todo 3');

      expect(todo2.sortOrder).toBe(1);
      expect(todo3.sortOrder).toBe(2);
    });
  });

  describe('findByProject', () => {
    it('should return all todos for a project sorted by sortOrder', async () => {
      await service.create(projectId, 'Todo A');
      await service.create(projectId, 'Todo B');
      await service.create(projectId, 'Todo C');

      // Update sort orders to test ordering
      await db.update(schema.todoItems)
        .set({ sortOrder: 2 })
        .where(eq(schema.todoItems.text, 'Todo A'));
      await db.update(schema.todoItems)
        .set({ sortOrder: 0 })
        .where(eq(schema.todoItems.text, 'Todo B'));
      await db.update(schema.todoItems)
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