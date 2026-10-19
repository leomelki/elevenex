import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { DRIZZLE } from '../database/database.provider.js';

describe('VS Code binary uploads (HTTP)', () => {
  let app: NestExpressApplication;
  let worktree: string;
  let taskLookup: jest.Mock;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'elevenex-upload-'));
    taskLookup = jest.fn().mockResolvedValue([
      {
        id: 108,
        path: worktree,
        taskState: 'ready',
        linkStatus: 'linked',
        archivedAt: null,
      },
    ]);
    const module = await Test.createTestingModule({
      controllers: [FilesController],
      providers: [
        FilesService,
        {
          provide: DRIZZLE,
          useValue: {
            select: () => ({
              from: () => ({ where: () => ({ limit: taskLookup }) }),
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    app.setGlobalPrefix('api');
    app.useBodyParser('json', { limit: '12mb' });
    app.useBodyParser('urlencoded', { extended: true, limit: '12mb' });
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    await rm(worktree, { recursive: true, force: true });
  });

  const uploadUrl = (root: string, file: string) =>
    `/api/worktrees/${encodeURIComponent(root)}/raw?path=${encodeURIComponent(file)}`;

  it('uploads gzip bytes larger than the JSON limit without corruption', async () => {
    const bytes = gzipSync(randomBytes(13 * 1024 * 1024));
    const file = 'nested/Trace-été #1%25.json.gz';
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, file))
      .set('Content-Type', 'application/octet-stream')
      .set('x-elevenex-task-id', '108')
      .send(bytes)
      .expect(200, { success: true });
    expect((await readFile(join(worktree, file))).equals(bytes)).toBe(true);
    expect(taskLookup).toHaveBeenCalledTimes(2);
  });

  it('accepts empty files', async () => {
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, 'empty.txt'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0))
      .expect(200);
    expect(await readFile(join(worktree, 'empty.txt'))).toHaveLength(0);
  });

  it('rejects stale task editors before writing', async () => {
    taskLookup.mockResolvedValue([]);
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, 'trace.gz'))
      .set('Content-Type', 'application/octet-stream')
      .set('x-elevenex-task-id', '108')
      .send(Buffer.from('data'))
      .expect(409);
    expect(await readdir(worktree)).toEqual([]);
  });

  it('discards the upload if the task becomes inactive while receiving it', async () => {
    taskLookup
      .mockResolvedValueOnce([
        {
          id: 108,
          path: worktree,
          taskState: 'ready',
          linkStatus: 'linked',
          archivedAt: null,
        },
      ])
      .mockResolvedValueOnce([]);
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, 'trace.gz'))
      .set('Content-Type', 'application/octet-stream')
      .set('x-elevenex-task-id', '108')
      .send(Buffer.from('data'))
      .expect(409);
    expect(await readdir(worktree)).toEqual([]);
  });

  it('rejects an upload without a file path', async () => {
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, ''))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('data'))
      .expect(400);
    expect(await readdir(worktree)).toEqual([]);
  });

  it('rejects paths outside the worktree', async () => {
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, '../outside.gz'))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('data'))
      .expect(400);
  });

  it('rejects JSON bodies on the raw upload route', async () => {
    await request(app.getHttpServer())
      .put(uploadUrl(worktree, 'trace.gz'))
      .send({ content: 'data' })
      .expect(415);
    expect(await readdir(worktree)).toEqual([]);
  });
});
