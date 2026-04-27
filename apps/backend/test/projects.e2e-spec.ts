import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { AppModule } from '../src/app.module.js';
import { DRIZZLE } from '../src/database/database.provider.js';
import * as schema from '../src/database/schema/index.js';

describe('Projects (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
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
  });

  it('POST /api/projects with {"name":"Test"} returns 201 with project object containing id', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'Test' })
      .expect(201);

    expect(response.body).toHaveProperty('id');
    expect(response.body.name).toBe('Test');
    expect(response.body).toHaveProperty('createdAt');
    expect(response.body).toHaveProperty('updatedAt');
  });

  it('GET /api/projects returns 200 with array containing created project', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/projects')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThanOrEqual(1);
    expect(response.body.some((p: { name: string }) => p.name === 'Test')).toBe(
      true,
    );
  });

  it('DELETE /api/projects/:id returns 200 with deleted project', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'ToDelete' })
      .expect(201);

    const id = createResponse.body.id;

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/api/projects/${id}`)
      .expect(200);

    expect(deleteResponse.body.id).toBe(id);
    expect(deleteResponse.body.name).toBe('ToDelete');
  });

  it('POST /api/projects with {} returns 400 (validation error)', async () => {
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({})
      .expect(400);
  });

  it('POST /api/projects with {"name":""} returns 400 (validation error)', async () => {
    await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: '' })
      .expect(400);
  });
});
