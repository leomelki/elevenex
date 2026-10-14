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
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReposService } from './repos.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

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
        {
          provide: SessionsService,
          useValue: {
            archiveAllByProject: jest.fn().mockResolvedValue(undefined),
          },
        },
        ProjectsService,
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

  describe('validatePath', () => {
    it('checks a repository without attaching it to a project', async () => {
      expect(await service.validatePath(`${gitRepoDir}/`)).toEqual({
        name: 'my-repo',
        path: gitRepoDir,
      });
      expect(await service.findByProject(projectId)).toEqual([]);
    });

    it('expands home-relative input consistently for validation and creation', async () => {
      const inputPath = `~/${path.relative(os.homedir(), gitRepoDir)}`;
      expect((await service.validatePath(inputPath)).path).toBe(gitRepoDir);
      expect((await service.addRepo(projectId, inputPath)).path).toBe(
        gitRepoDir,
      );
    });

    it('accepts the .git file used by linked worktrees', async () => {
      fs.rmSync(path.join(gitRepoDir, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(gitRepoDir, '.git'),
        'gitdir: /work/main/.git/worktrees/my-repo',
      );
      expect((await service.validatePath(gitRepoDir)).name).toBe('my-repo');
    });

    it('rejects empty and non-repository folders without adding a repository', async () => {
      await expect(service.validatePath('  ')).rejects.toThrow(
        'Choose a repository folder',
      );
      await expect(service.validatePath(nonGitDir)).rejects.toThrow(
        'Not a git repository',
      );
      expect(await service.findByProject(projectId)).toEqual([]);
    });
  });

  describe('suggestRepositories', () => {
    it('deduplicates saved paths, includes archived projects and excludes hidden agent repositories', async () => {
      const added = await db
        .insert(schema.projects)
        .values([
          { name: 'Other project' },
          { name: 'Archived project', archivedAt: '2026-01-01T00:00:00Z' },
          { name: 'Agent', hidden: true },
        ])
        .returning();
      await db.insert(schema.repos).values([
        { projectId, name: 'api', path: '/work/api' },
        { projectId: added[0].id, name: 'api', path: '/work/api' },
        { projectId: added[1].id, name: 'frontend', path: '/work/frontend' },
        { projectId: added[2].id, name: 'agent', path: '/work/agent' },
      ]);
      expect(await service.suggestRepositories()).toEqual([
        { name: 'frontend', path: '/work/frontend' },
        { name: 'api', path: '/work/api' },
      ]);
    });

    it('searches names and paths case-insensitively, with literal wildcard characters', async () => {
      await db.insert(schema.repos).values([
        { projectId, name: 'API-core', path: '/missing/services/api' },
        { projectId, name: 'literal%_repo', path: '/missing/literal%_repo' },
        { projectId, name: 'literalXXrepo', path: '/missing/literalXXrepo' },
      ]);
      expect(
        (await service.suggestRepositories('api')).map((repo) => repo.name),
      ).toEqual(['API-core']);
      expect(
        (await service.suggestRepositories('services')).map(
          (repo) => repo.name,
        ),
      ).toEqual(['API-core']);
      expect(
        (await service.suggestRepositories('%_')).map((repo) => repo.name),
      ).toEqual(['literal%_repo']);
    });

    it('bounds the metadata response and returns the newest additions first', async () => {
      await db.insert(schema.repos).values([
        { projectId, name: 'old', path: '/work/old' },
        { projectId, name: 'new', path: '/work/new' },
        { projectId, name: 'latest', path: '/work/latest' },
      ]);
      expect(
        (await service.suggestRepositories('', 2)).map((repo) => repo.name),
      ).toEqual(['latest', 'new']);
    });
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
      await expect(service.addRepo(projectId, nonGitDir)).rejects.toThrow(
        BadRequestException,
      );

      await expect(service.addRepo(projectId, nonGitDir)).rejects.toThrow(
        'Not a git repository',
      );
    });

    it('should throw ConflictException for duplicate path in same project', async () => {
      await service.addRepo(projectId, gitRepoDir);

      await expect(service.addRepo(projectId, gitRepoDir)).rejects.toThrow(
        ConflictException,
      );

      await expect(service.addRepo(projectId, gitRepoDir)).rejects.toThrow(
        'already added',
      );
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
      await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

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
