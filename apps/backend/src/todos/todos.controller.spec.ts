import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { TodosController, TodosItemController } from './todos.controller.js';
import { TodosService } from './todos.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

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

describe('TodosController', () => {
  let controller: TodosController;
  let service: TodosService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let projectId: number;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TodosController],
      providers: [
        TodosService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    controller = module.get<TodosController>(TodosController);
    service = module.get<TodosService>(TodosService);

    // Create a test project
    const result = await db.insert(schema.projects).values({ name: 'Test Project' }).returning();
    projectId = result[0].id;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('findByProject', () => {
    it('should return 200 with todos array', async () => {
      await service.create(projectId, 'Todo 1');
      await service.create(projectId, 'Todo 2');

      const result = await controller.findByProject(projectId);

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('Todo 1');
      expect(result[1].text).toBe('Todo 2');
    });

    it('should return empty array when no todos', async () => {
      const result = await controller.findByProject(projectId);
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create todo and return it', async () => {
      const dto = { text: 'New todo' };

      const result = await controller.create(projectId, dto);

      expect(result.text).toBe('New todo');
      expect(result.projectId).toBe(projectId);
      expect(result.completed).toBe(false);
    });
  });

  describe('clearCompleted', () => {
    it('should clear completed todos and return count', async () => {
      const t1 = await service.create(projectId, 'Todo 1');
      const t2 = await service.create(projectId, 'Todo 2');
      await service.update(t1.id, { completed: true });

      const result = await controller.clearCompleted(projectId);

      expect(result.count).toBe(1);

      const remaining = await service.findByProject(projectId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(t2.id);
    });
  });

  describe('updateSortOrders', () => {
    it('should update sort orders for multiple todos', async () => {
      const t1 = await service.create(projectId, 'Todo 1');
      const t2 = await service.create(projectId, 'Todo 2');
      const dto = { projectId, orders: [{ id: t1.id, sortOrder: 1 }, { id: t2.id, sortOrder: 0 }] };

      await controller.updateSortOrders(projectId, dto);

      const todos = await service.findByProject(projectId);
      expect(todos[0].id).toBe(t2.id);
      expect(todos[1].id).toBe(t1.id);
    });
  });
});

describe('TodosItemController', () => {
  let controller: TodosItemController;
  let service: TodosService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let projectId: number;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TodosItemController],
      providers: [
        TodosService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    controller = module.get<TodosItemController>(TodosItemController);
    service = module.get<TodosService>(TodosService);

    // Create a test project
    const result = await db.insert(schema.projects).values({ name: 'Test Project' }).returning();
    projectId = result[0].id;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('update', () => {
    it('should update todo and return it', async () => {
      const todo = await service.create(projectId, 'Original');
      const dto = { text: 'Updated', completed: true };

      const result = await controller.update(todo.id, dto);

      expect(result.text).toBe('Updated');
      expect(result.completed).toBe(true);
    });

    it('should allow partial update', async () => {
      const todo = await service.create(projectId, 'Test');
      const dto = { completed: true };

      const result = await controller.update(todo.id, dto);

      expect(result.completed).toBe(true);
      expect(result.text).toBe('Test');
    });
  });

  describe('delete', () => {
    it('should delete todo and return it', async () => {
      const todo = await service.create(projectId, 'To Delete');

      const result = await controller.delete(todo.id);

      expect(result.id).toBe(todo.id);

      const todos = await service.findByProject(projectId);
      expect(todos).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent todo', async () => {
      await expect(controller.delete(999)).rejects.toThrow(NotFoundException);
    });
  });
});