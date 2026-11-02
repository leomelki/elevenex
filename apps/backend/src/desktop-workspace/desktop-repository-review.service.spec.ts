import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TasksService } from '../tasks/tasks.service.js';
import { ReposService } from '../repos/repos.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import { DesktopRepositoryReviewController } from './desktop-repository-review.controller.js';
import { DesktopRepositoryReviewService } from './desktop-repository-review.service.js';
import { reviewGit } from './repository-review-git.js';

jest.setTimeout(30000);
describe('repository review HTTP/task ownership', () => {
  let cwd: string, app: INestApplication;
  let state: string;
  const record = jest.fn();
  const defaultBase = jest.fn();
  const repo = jest.fn();
  beforeEach(async () => {
    state = 'ready';
    cwd = await mkdtemp(path.join(tmpdir(), 'elevenex-review-http-'));
    await reviewGit(cwd, ['init', '-b', 'trunk']);
    await reviewGit(cwd, ['config', 'user.name', 'Review']);
    await reviewGit(cwd, ['config', 'user.email', 'review@example.test']);
    await writeFile(path.join(cwd, 'file.txt'), 'base\n');
    await reviewGit(cwd, ['add', '-A']);
    await reviewGit(cwd, ['commit', '-m', 'base']);
    await reviewGit(cwd, ['checkout', '-b', 'topic']);
    await writeFile(path.join(cwd, 'file.txt'), 'committed\n');
    await reviewGit(cwd, ['add', '-A']);
    await reviewGit(cwd, ['commit', '-m', 'topic']);
    record.mockImplementation(async () => ({
      id: 7,
      repoId: 9,
      path: cwd,
      taskState: state,
      linkStatus: 'linked',
      taskBranch: 'topic',
      sourceRef: 'topic',
      createdFromRef: 'refs/heads/trunk',
      startingCommit: null,
    }));
    repo.mockResolvedValue({ id: 9, taskBaseRef: 'refs/heads/trunk' });
    defaultBase.mockResolvedValue('refs/heads/trunk');
    const module = await Test.createTestingModule({
      controllers: [DesktopRepositoryReviewController],
      providers: [
        DesktopRepositoryReviewService,
        { provide: TasksService, useValue: { record } },
        { provide: ReposService, useValue: { findOne: repo } },
        { provide: TaskGitService, useValue: { defaultBase } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    await rm(cwd, { recursive: true, force: true });
    jest.clearAllMocks();
  });
  const read = (body: object) =>
    request(app.getHttpServer())
      .post('/api/desktop-workspace/tasks/7/review')
      .send({ taskId: 7, requestId: 'test', source: 'uncommitted', ...body });
  it('reviews a task without a conversation and defaults to its recorded base, never its own sourceRef', async () => {
    const branch = await read({ source: 'branch' }).expect(201);
    expect(branch.body.baseRef).toBe('refs/heads/trunk');
    expect(branch.body.total).toBe(1);
    await writeFile(path.join(cwd, 'untracked.txt'), 'new\n');
    const working = await read({}).expect(201);
    expect(working.body.files[0].path).toBe('untracked.txt');
    repo.mockClear();
    defaultBase.mockClear();
    const file = working.body.files[0];
    const content = await read({
      revision: working.body.revision,
      fileId: file.id,
      fileRev: file.rev,
    }).expect(201);
    expect(content.body.content.hunks[0].lines[0].text).toBe('new');
    expect(repo).not.toHaveBeenCalled();
    expect(defaultBase).not.toHaveBeenCalled();
  });
  it('rejects mismatched identities, unsupported operations and unavailable checkouts', async () => {
    await read({ taskId: 8 }).expect(400);
    await read({ source: 'reply' }).expect(400);
    await read({ command: 'git reset --hard' }).expect(400);
    state = 'finished';
    const closed = await read({}).expect(409);
    expect(closed.body.code).toBe('review-task');
  });
  it('bounds branch search and lets a filtered query reach an omitted ref', async () => {
    await Promise.all(
      Array.from({ length: 125 }, (_, i) =>
        reviewGit(cwd, [
          'branch',
          `base-${String(i).padStart(3, '0')}`,
          'trunk',
        ]),
      ),
    );
    const first = await request(app.getHttpServer())
      .get('/api/desktop-workspace/tasks/7/review/branches')
      .expect(200);
    expect(first.body.refs).toHaveLength(50);
    expect(first.body.hasMore).toBe(true);
    const found = await request(app.getHttpServer())
      .get('/api/desktop-workspace/tasks/7/review/branches?query=base-124')
      .expect(200);
    expect(found.body.refs).toEqual(['refs/heads/base-124']);
    expect(found.body.hasMore).toBe(false);
  });
});
