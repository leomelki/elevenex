import { SessionsService } from '../sessions/sessions.service.js';
import { createTestDb } from '../database/testing/create-test-db.js';
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { ProjectsService } from './projects.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;

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
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('create', () => {
    it('should insert a project and return it with id, name, createdAt, updatedAt', async () => {
      const result = await service.create('My Project');

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.name).toBe('My Project');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should create isolated browser settings with Google accounts shared', async () => {
      const project = await service.create('My Project');

      const rows = await db
        .select()
        .from(schema.browserIsolationSettings)
        .where(eq(schema.browserIsolationSettings.projectId, project.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe('isolated');
      expect(JSON.parse(rows[0].sharedGlobs)).toEqual([
        'https://accounts.google.com/*',
      ]);
    });

    it('should throw ConflictException on duplicate name', async () => {
      await service.create('My Project');

      await expect(service.create('My Project')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findAll', () => {
    it('should return all projects as an array', async () => {
      await service.create('Project A');
      await service.create('Project B');

      const results = await service.findAll();

      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Project A');
      expect(results[1].name).toBe('Project B');
    });

    it('should return empty array when no projects exist', async () => {
      const results = await service.findAll();
      expect(results).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('should return the project by id', async () => {
      const created = await service.create('My Project');

      const found = await service.findOne(created.id);

      expect(found.id).toBe(created.id);
      expect(found.name).toBe('My Project');
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('should remove the project and return the deleted row', async () => {
      const created = await service.create('My Project');

      const deleted = await service.delete(created.id);

      expect(deleted.id).toBe(created.id);
      expect(deleted.name).toBe('My Project');

      const all = await service.findAll();
      expect(all).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.delete(999)).rejects.toThrow(NotFoundException);
    });
  });
});
