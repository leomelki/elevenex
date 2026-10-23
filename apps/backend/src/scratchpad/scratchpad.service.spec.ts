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
import { ScratchpadService } from './scratchpad.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { eq } from 'drizzle-orm';

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
        {
          provide: SessionsService,
          useValue: {
            archiveAllByProject: jest.fn().mockResolvedValue(undefined),
          },
        },
        ProjectsService,
        ScratchpadService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<ScratchpadService>(ScratchpadService);

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
    it('should create a section with correct fields', async () => {
      const result = await service.create(
        projectId,
        'My Section',
        'Test description',
      );

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

    it('should append consecutive sort orders', async () => {
      await service.create(projectId, 'Section 1');
      const section2 = await service.create(projectId, 'Section 2');
      const section3 = await service.create(projectId, 'Section 3');

      expect(section2.sortOrder).toBe(1);
      expect(section3.sortOrder).toBe(2);
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
      const section = await service.create(projectId, 'Existing');
      await service.updateSortOrders(projectId, [
        { id: section.id, sortOrder: 42 },
      ]);
      const otherProject = db
        .insert(schema.projects)
        .values({ name: 'Other project' })
        .returning()
        .get()!;
      db.insert(schema.scratchpadSections)
        .values({ projectId: otherProject.id, name: 'Other', sortOrder: 100 })
        .run();

      expect((await service.create(projectId, 'Appended')).sortOrder).toBe(43);
    });

    it('should start an empty project at zero independently of other projects', async () => {
      const otherProject = db
        .insert(schema.projects)
        .values({ name: 'Other project' })
        .returning()
        .get()!;
      db.insert(schema.scratchpadSections)
        .values({ projectId: otherProject.id, name: 'Other', sortOrder: 100 })
        .run();

      expect((await service.create(projectId, 'First')).sortOrder).toBe(0);
    });

    it('should allocate distinct sort orders for concurrent creates', async () => {
      const created = await Promise.all(
        ['First', 'Second', 'Third'].map((name) =>
          service.create(projectId, name),
        ),
      );

      expect(created.map((section) => section.sortOrder).sort()).toEqual([
        0, 1, 2,
      ]);
      expect(await service.findByProject(projectId)).toHaveLength(3);
    });
  });

  describe('findByProject', () => {
    it('should return all sections for a project sorted by sortOrder', async () => {
      await service.create(projectId, 'Section A');
      await service.create(projectId, 'Section B');
      await service.create(projectId, 'Section C');

      // Update sort orders to test ordering
      await db
        .update(schema.scratchpadSections)
        .set({ sortOrder: 2 })
        .where(eq(schema.scratchpadSections.name, 'Section A'));
      await db
        .update(schema.scratchpadSections)
        .set({ sortOrder: 0 })
        .where(eq(schema.scratchpadSections.name, 'Section B'));
      await db
        .update(schema.scratchpadSections)
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

      const updated = await service.update(section.id, {
        content: 'Only content',
      });

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

    it('should reorder a subset without changing omitted sections or normalizing orders', async () => {
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
      const section = await service.create(projectId, 'Unchanged');

      await service.updateSortOrders(projectId, []);

      expect(await service.findByProject(projectId)).toEqual([section]);
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
          .insert(schema.scratchpadSections)
          .values({
            projectId: otherProject.id,
            name: 'Foreign',
            sortOrder: 50,
          })
          .returning()
          .get()!;
        const before = db.select().from(schema.scratchpadSections).all();

        await expect(
          service.updateSortOrders(projectId, [
            { id: own.id, sortOrder: 10 },
            { id: foreign.id, sortOrder: 20 },
          ]),
        ).rejects.toThrow(NotFoundException);

        expect(db.select().from(schema.scratchpadSections).all()).toEqual(
          before,
        );
      },
    );

    it.each(['duplicate', 'missing'] as const)(
      'should reject a %s ID before issuing any ordering writes',
      async (invalid) => {
        const first = await service.create(projectId, 'First');
        const second = await service.create(projectId, 'Second');
        const before = db.select().from(schema.scratchpadSections).all();
        sqlite.exec(`
          CREATE TRIGGER reject_ordering_write BEFORE UPDATE OF sort_order ON scratchpad_sections
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

        expect(db.select().from(schema.scratchpadSections).all()).toEqual(
          before,
        );
      },
    );

    it('should roll back the entire batch when a later database write fails', async () => {
      const first = await service.create(projectId, 'First');
      const second = await service.create(projectId, 'Second');
      const before = db.select().from(schema.scratchpadSections).all();
      sqlite.exec(`
        CREATE TRIGGER fail_reorder AFTER UPDATE OF sort_order ON scratchpad_sections
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

      expect(db.select().from(schema.scratchpadSections).all()).toEqual(before);
      expect(sqlite.inTransaction).toBe(false);
    });

    it('should reject reordering an archived project', async () => {
      const section = await service.create(projectId, 'Archived');
      db.update(schema.projects)
        .set({ archivedAt: '2026-01-01T00:00:00.000Z' })
        .where(eq(schema.projects.id, projectId))
        .run();

      await expect(
        service.updateSortOrders(projectId, [
          { id: section.id, sortOrder: 10 },
        ]),
      ).rejects.toThrow(ConflictException);
      await expect(service.updateSortOrders(projectId, [])).rejects.toThrow(
        ConflictException,
      );

      expect(await service.findByProject(projectId)).toEqual([section]);
    });

    it('should reject reordering a missing project', async () => {
      const section = await service.create(projectId, 'Unchanged');

      await expect(
        service.updateSortOrders(projectId + 1, [
          { id: section.id, sortOrder: 10 },
        ]),
      ).rejects.toThrow(NotFoundException);
      await expect(service.updateSortOrders(projectId + 1, [])).rejects.toThrow(
        NotFoundException,
      );

      expect(await service.findByProject(projectId)).toEqual([section]);
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
