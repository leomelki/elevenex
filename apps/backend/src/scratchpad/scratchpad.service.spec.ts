import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ScratchpadService } from './scratchpad.service.js';
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
    CREATE TABLE scratchpad_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL DEFAULT '',
      is_markdown INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('ScratchpadService', () => {
  let service: ScratchpadService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let projectId: number;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScratchpadService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<ScratchpadService>(ScratchpadService);

    // Create a test project for all tests
    const result = await db.insert(schema.projects).values({ name: 'Test Project' }).returning();
    projectId = result[0].id;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('create', () => {
    it('should create a section with correct fields', async () => {
      const result = await service.create(projectId, 'My Section', 'Test description');

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.projectId).toBe(projectId);
      expect(result.name).toBe('My Section');
      expect(result.description).toBe('Test description');
      expect(result.content).toBe('');
      expect(result.isMarkdown).toBe(true);
      expect(result.sortOrder).toBe(0);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should create section without description', async () => {
      const result = await service.create(projectId, 'No Description');

      expect(result.name).toBe('No Description');
      expect(result.description).toBeNull();
    });

    it('should assign sortOrder based on existing sections count', async () => {
      await service.create(projectId, 'Section 1');
      const section2 = await service.create(projectId, 'Section 2');
      const section3 = await service.create(projectId, 'Section 3');

      expect(section2.sortOrder).toBe(1);
      expect(section3.sortOrder).toBe(2);
    });
  });

  describe('findByProject', () => {
    it('should return all sections for a project sorted by sortOrder', async () => {
      await service.create(projectId, 'Section A');
      await service.create(projectId, 'Section B');
      await service.create(projectId, 'Section C');

      // Update sort orders to test ordering
      await db.update(schema.scratchpadSections)
        .set({ sortOrder: 2 })
        .where(eq(schema.scratchpadSections.name, 'Section A'));
      await db.update(schema.scratchpadSections)
        .set({ sortOrder: 0 })
        .where(eq(schema.scratchpadSections.name, 'Section B'));
      await db.update(schema.scratchpadSections)
        .set({ sortOrder: 1 })
        .where(eq(schema.scratchpadSections.name, 'Section C'));

      const results = await service.findByProject(projectId);

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('Section B'); // sortOrder 0
      expect(results[1].name).toBe('Section C'); // sortOrder 1
      expect(results[2].name).toBe('Section A'); // sortOrder 2
    });

    it('should return empty array when no sections exist', async () => {
      const results = await service.findByProject(projectId);
      expect(results).toEqual([]);
    });
  });

  describe('update', () => {
    it('should update section fields', async () => {
      const section = await service.create(projectId, 'Original Name');

      const updated = await service.update(section.id, {
        name: 'Updated Name',
        description: 'New description',
        content: 'New content',
        isMarkdown: false,
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.description).toBe('New description');
      expect(updated.content).toBe('New content');
      expect(updated.isMarkdown).toBe(false);
    });

    it('should allow partial updates', async () => {
      const section = await service.create(projectId, 'Test', 'Desc');

      const updated = await service.update(section.id, { content: 'Only content' });

      expect(updated.name).toBe('Test');
      expect(updated.description).toBe('Desc');
      expect(updated.content).toBe('Only content');
    });

    it('should allow setting description to null', async () => {
      const section = await service.create(projectId, 'Test', 'Desc');

      const updated = await service.update(section.id, { description: null });

      expect(updated.description).toBeNull();
    });
  });

  describe('updateSortOrders', () => {
    it('should update sortOrder for multiple sections', async () => {
      const s1 = await service.create(projectId, 'Section 1');
      const s2 = await service.create(projectId, 'Section 2');
      const s3 = await service.create(projectId, 'Section 3');

      await service.updateSortOrders(projectId, [
        { id: s1.id, sortOrder: 2 },
        { id: s2.id, sortOrder: 0 },
        { id: s3.id, sortOrder: 1 },
      ]);

      const results = await service.findByProject(projectId);

      expect(results[0].id).toBe(s2.id);
      expect(results[1].id).toBe(s3.id);
      expect(results[2].id).toBe(s1.id);
    });
  });

  describe('delete', () => {
    it('should delete a section', async () => {
      const section = await service.create(projectId, 'To Delete');

      await service.delete(section.id);

      const results = await service.findByProject(projectId);
      expect(results).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent section', async () => {
      await expect(service.delete(999)).rejects.toThrow(NotFoundException);
    });
  });
});