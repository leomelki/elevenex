import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReposService } from './repos.service.js';
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
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT,
      preferred_context_root_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, path)
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe('ReposService', () => {
  let service: ReposService;
  let db: BetterSQLite3Database<typeof schema>;
  let sqliteConn: InstanceType<typeof Database>;
  let projectId: number;
  let tmpDir: string;
  let gitRepoDir: string;
  let nonGitDir: string;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqliteConn = testDb.sqlite;

    // Seed a project
    const rows = await db
      .insert(schema.projects)
      .values({ name: 'Test Project' })
      .returning();
    projectId = rows[0].id;

    // Create temp directories for filesystem validation tests
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-test-'));
    gitRepoDir = path.join(tmpDir, 'my-repo');
    fs.mkdirSync(gitRepoDir);
    fs.mkdirSync(path.join(gitRepoDir, '.git'));

    nonGitDir = path.join(tmpDir, 'not-a-repo');
    fs.mkdirSync(nonGitDir);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReposService,
        { provide: DRIZZLE, useValue: db },
      ],
    }).compile();

    service = module.get<ReposService>(ReposService);
  });

  afterEach(() => {
    sqliteConn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('addRepo', () => {
    it('should validate path exists, has .git, derive name from basename, and return repo', async () => {
      const result = await service.addRepo(projectId, gitRepoDir);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.projectId).toBe(projectId);
      expect(result.name).toBe('my-repo');
      expect(result.path).toBe(gitRepoDir);
      expect(result.createdAt).toBeDefined();
    });

    it('should throw BadRequestException for nonexistent path', async () => {
      await expect(
        service.addRepo(projectId, '/nonexistent/path/that/does/not/exist'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.addRepo(projectId, '/nonexistent/path/that/does/not/exist'),
      ).rejects.toThrow('Folder not found');
    });

    it('should throw BadRequestException for directory without .git', async () => {
      await expect(
        service.addRepo(projectId, nonGitDir),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.addRepo(projectId, nonGitDir),
      ).rejects.toThrow('Not a git repository');
    });

    it('should throw ConflictException for duplicate path in same project', async () => {
      await service.addRepo(projectId, gitRepoDir);

      await expect(
        service.addRepo(projectId, gitRepoDir),
      ).rejects.toThrow(ConflictException);

      await expect(
        service.addRepo(projectId, gitRepoDir),
      ).rejects.toThrow('already added');
    });
  });

  describe('findByProject', () => {
    it('should return all repos for a project', async () => {
      await service.addRepo(projectId, gitRepoDir);

      const results = await service.findByProject(projectId);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('my-repo');
    });

    it('should return empty array when project has no repos', async () => {
      const results = await service.findByProject(projectId);
      expect(results).toEqual([]);
    });
  });

  describe('remove', () => {
    it('should delete the repo and return it', async () => {
      const created = await service.addRepo(projectId, gitRepoDir);

      const deleted = await service.remove(created.id);

      expect(deleted.id).toBe(created.id);
      expect(deleted.name).toBe('my-repo');

      const remaining = await service.findByProject(projectId);
      expect(remaining).toHaveLength(0);
    });

    it('should throw NotFoundException for non-existent id', async () => {
      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cascade delete', () => {
    it('should delete repos when their project is deleted', async () => {
      await service.addRepo(projectId, gitRepoDir);

      // Delete the project directly via DB
      await db
        .delete(schema.projects)
        .where(eq(schema.projects.id, projectId));

      // Verify repos are cascade-deleted
      const repos = await db.select().from(schema.repos);
      expect(repos).toHaveLength(0);
    });
  });

  describe('countByProject', () => {
    it('should return count of repos for a project', async () => {
      expect(await service.countByProject(projectId)).toBe(0);

      await service.addRepo(projectId, gitRepoDir);
      expect(await service.countByProject(projectId)).toBe(1);
    });
  });
});
