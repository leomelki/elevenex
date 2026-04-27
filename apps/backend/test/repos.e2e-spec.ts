import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppModule } from '../src/app.module.js';
import { DRIZZLE } from '../src/database/database.provider.js';
import * as schema from '../src/database/schema/index.js';

describe('Repos (e2e)', () => {
  let app: INestApplication;
  let tmpDir: string;
  let gitRepoDir: string;

  beforeAll(async () => {
    // Create temp directories for filesystem validation
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repos-e2e-'));
    gitRepoDir = path.join(tmpDir, 'test-repo');
    fs.mkdirSync(gitRepoDir);
    fs.mkdirSync(path.join(gitRepoDir, '.git'));

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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, path)
      );
    `);
    const db = drizzle(sqlite, { schema });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DRIZZLE)
      .useValue(db)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let projectId: number;

  it('should create a project first', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'RepoTestProject' })
      .expect(201);

    projectId = response.body.id;
    expect(projectId).toBeDefined();
  });

  it('POST /api/projects/:id/repos with {"path":"/valid/path"} returns 201', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/repos`)
      .send({ path: gitRepoDir })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.projectId).toBe(projectId);
    expect(response.body.name).toBe('test-repo');
    expect(response.body.path).toBe(gitRepoDir);
  });

  it('GET /api/projects/:id/repos returns repos for the project', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/projects/${projectId}/repos`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /api/repos/:id returns 200', async () => {
    // Create another repo to delete
    const anotherDir = path.join(tmpDir, 'another-repo');
    fs.mkdirSync(anotherDir);
    fs.mkdirSync(path.join(anotherDir, '.git'));

    const createResponse = await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/repos`)
      .send({ path: anotherDir })
      .expect(201);

    const repoId = createResponse.body.id;

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/api/repos/${repoId}`)
      .expect(200);

    expect(deleteResponse.body.id).toBe(repoId);
  });

  it('POST /api/projects/:id/repos with {"path":""} returns 400', async () => {
    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/repos`)
      .send({ path: '' })
      .expect(400);
  });

  it('POST /api/projects/:id/repos with {} returns 400', async () => {
    await request(app.getHttpServer())
      .post(`/api/projects/${projectId}/repos`)
      .send({})
      .expect(400);
  });
});
