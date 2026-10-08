import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  ScratchpadController,
  ScratchpadSectionController,
} from './scratchpad.controller.js';
import { ScratchpadService } from './scratchpad.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

describe('ScratchpadController', () => {
  let controller: ScratchpadController;
  let sectionController: ScratchpadSectionController;
  let service: ScratchpadService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let projectId: number;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScratchpadController, ScratchpadSectionController],
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

    controller = module.get<ScratchpadController>(ScratchpadController);
    sectionController = module.get<ScratchpadSectionController>(
      ScratchpadSectionController,
    );
    service = module.get<ScratchpadService>(ScratchpadService);

    // Create a test project
    const result = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    projectId = result[0].id;
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('findByProject', () => {
    it('should return 200 with sections array', async () => {
      await service.create(projectId, 'Section 1');
      await service.create(projectId, 'Section 2');

      const result = await controller.findByProject(projectId);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Section 1');
      expect(result[1].name).toBe('Section 2');
    });

    it('should return empty array when no sections', async () => {
      const result = await controller.findByProject(projectId);
      expect(result).toEqual([]);
    });
  });

  describe('create', () => {
    it('should create section and return it', async () => {
      const dto = { name: 'New Section', description: 'Test' };

      const result = await controller.create(projectId, dto);

      expect(result.name).toBe('New Section');
      expect(result.description).toBe('Test');
      expect(result.projectId).toBe(projectId);
    });

    it('should create section without description', async () => {
      const dto = { name: 'No Desc' };

      const result = await controller.create(projectId, dto);

      expect(result.name).toBe('No Desc');
      expect(result.description).toBeNull();
    });
  });

  describe('update', () => {
    it('should update section and return it', async () => {
      const section = await service.create(projectId, 'Original');
      const dto = { name: 'Updated', content: 'New content' };

      const result = await sectionController.update(section.id, dto);

      expect(result.name).toBe('Updated');
      expect(result.content).toBe('New content');
    });

    it('should allow partial update', async () => {
      const section = await service.create(projectId, 'Test');
      const dto = { isMarkdown: false };

      const result = await sectionController.update(section.id, dto);

      expect(result.isMarkdown).toBe(false);
      expect(result.name).toBe('Test');
    });
  });

  describe('updateSortOrders', () => {
    it('should update sort orders for multiple sections', async () => {
      const s1 = await service.create(projectId, 'Section 1');
      const s2 = await service.create(projectId, 'Section 2');
      const dto = {
        projectId,
        orders: [
          { id: s1.id, sortOrder: 1 },
          { id: s2.id, sortOrder: 0 },
        ],
      };

      await controller.updateSortOrders(projectId, dto);

      const sections = await service.findByProject(projectId);
      expect(sections[0].id).toBe(s2.id);
      expect(sections[1].id).toBe(s1.id);
    });
  });

  describe('delete', () => {
    it('should delete section and return it', async () => {
      const section = await service.create(projectId, 'To Delete');

      const result = await sectionController.delete(section.id);

      expect(result.id).toBe(section.id);

      const sections = await service.findByProject(projectId);
      expect(sections).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent section', async () => {
      await expect(sectionController.delete(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
