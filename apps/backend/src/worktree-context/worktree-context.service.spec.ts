import { Test, TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import simpleGit from 'simple-git';
import { WorktreeContextService } from './worktree-context.service.js';
import { DRIZZLE } from '../database/database.provider.js';
import { SessionsService } from '../sessions/sessions.service.js';

jest.mock('simple-git', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}), { virtual: true });

describe('WorktreeContextService', () => {
  let service: WorktreeContextService;
  let sessionsServiceMock: {
    findOne: jest.Mock;
    markWorktreeContextInjected: jest.Mock;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionsServiceMock = {
      findOne: jest.fn(),
      markWorktreeContextInjected: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorktreeContextService,
        {
          provide: DRIZZLE,
          useValue: {
            select: jest.fn(() => ({
              from: jest.fn(() => ({
                where: jest.fn(() => Promise.resolve([])),
              })),
            })),
            update: jest.fn(() => ({
              set: jest.fn(() => ({
                where: jest.fn(() => Promise.resolve()),
              })),
            })),
            insert: jest.fn(() => ({
              values: jest.fn(() => Promise.resolve()),
            })),
          },
        },
        {
          provide: SessionsService,
          useValue: sessionsServiceMock,
        },
      ],
    }).compile();

    service = module.get(WorktreeContextService);
  });

  it('coalesces concurrent snapshot requests for the same worktree', async () => {
    const branchContext = {
      rootRef: 'origin/main',
      resolvedRootRef: 'origin/main',
      usingRepoDefaultRootRef: true,
      hasChanges: false,
      commits: [],
      changedFiles: [],
      diffSummary: '',
    };
    let resolveBranchContext!: (value: typeof branchContext) => void;
    const branchContextPromise = new Promise<typeof branchContext>((resolve) => {
      resolveBranchContext = resolve;
    });

    jest.spyOn(service as any, 'getRepo').mockResolvedValue({
      id: 1,
      preferredContextRootRef: null,
    });
    jest.spyOn(service as any, 'findRecord').mockResolvedValue(null);
    const collectSpy = jest
      .spyOn(service as any, 'collectBranchContext')
      .mockReturnValue(branchContextPromise);

    const first = service.getSnapshot(1, '/tmp/worktree-a');
    const second = service.getSnapshot(1, '/tmp/worktree-a');

    await new Promise((resolve) => setImmediate(resolve));
    expect(collectSpy).toHaveBeenCalledTimes(1);

    resolveBranchContext(branchContext);
    const [left, right] = await Promise.all([first, second]);

    expect(left).toEqual(right);
    expect(left).toEqual(
      expect.objectContaining({
        repoId: 1,
        worktreePath: '/tmp/worktree-a',
        hasChanges: false,
        contextSentence: null,
      }),
    );
  });

  it('caches empty snapshots for one minute', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);

    jest.spyOn(service as any, 'getRepo').mockResolvedValue({
      id: 1,
      preferredContextRootRef: null,
    });
    jest.spyOn(service as any, 'findRecord').mockResolvedValue(null);
    const collectSpy = jest
      .spyOn(service as any, 'collectBranchContext')
      .mockResolvedValue({
        rootRef: 'origin/main',
        resolvedRootRef: 'origin/main',
        usingRepoDefaultRootRef: true,
        hasChanges: false,
        commits: [],
        changedFiles: [],
        diffSummary: '',
      } as never);

    await service.getSnapshot(1, '/tmp/worktree-b');
    await service.getSnapshot(1, '/tmp/worktree-b');
    expect(collectSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(61_001);
    await service.getSnapshot(1, '/tmp/worktree-b');
    expect(collectSpy).toHaveBeenCalledTimes(2);
  });

  it('returns a cached-only snapshot without collecting git branch context', async () => {
    jest.spyOn(service as any, 'getRepo').mockResolvedValue({
      id: 1,
      preferredContextRootRef: null,
    });
    jest.spyOn(service as any, 'findRecord').mockResolvedValue({
      id: 9,
      repoId: 1,
      worktreePath: '/tmp/worktree-cache',
      rootRef: 'origin/main',
      contextSentence: 'Cached context sentence.',
      generationStatus: 'ready',
      generatedAt: '2026-04-24T08:00:00.000Z',
      lastUsedAt: null,
      createdAt: '2026-04-24T08:00:00.000Z',
      updatedAt: '2026-04-24T08:00:00.000Z',
    });
    const collectSpy = jest.spyOn(service as any, 'collectBranchContext');

    const result = await service.getCachedSnapshot(1, '/tmp/worktree-cache');

    expect(result).toEqual(
      expect.objectContaining({
        contextSentence: 'Cached context sentence.',
        generationStatus: 'ready',
        hasRecord: true,
      }),
    );
    expect(collectSpy).not.toHaveBeenCalled();
  });

  it('returns early from branch context collection when there are no commits and git status is clean', async () => {
    const raw = jest.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        return 'origin/main\n';
      }
      if (args[0] === 'merge-base') {
        return 'abc123\n';
      }
      if (args[0] === 'status') {
        return '';
      }
      throw new Error(`Unexpected git.raw call: ${args.join(' ')}`);
    });
    const log = jest.fn().mockResolvedValue({ all: [] });

    (simpleGit as jest.Mock).mockReturnValue({
      env: jest.fn().mockReturnValue({ raw, log }),
    });

    const result = await (service as any).collectBranchContext(
      '/tmp/worktree-c',
      null,
      'origin/main',
    );

    expect(result).toEqual(
      expect.objectContaining({
        resolvedRootRef: 'origin/main',
        hasChanges: false,
        commits: [],
        changedFiles: [],
        diffSummary: '',
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(3);
  });

  it('consumes a provided context sentence without refetching the snapshot', async () => {
    sessionsServiceMock.findOne.mockResolvedValue({
      id: 7,
      repoId: 1,
      worktreePath: '/tmp/worktree-d',
      hasInjectedWorktreeContext: false,
    });
    sessionsServiceMock.markWorktreeContextInjected.mockResolvedValue({});
    const getSnapshotSpy = jest.spyOn(service, 'getSnapshot');
    const touchSpy = jest.spyOn(service as any, 'touchLastUsed').mockResolvedValue(undefined);

    const result = await service.consumeForSession(
      7,
      true,
      '  This branch updates first-message context handling.  ',
    );

    expect(result).toEqual({
      shouldInject: true,
      contextSentence: 'This branch updates first-message context handling.',
    });
    expect(getSnapshotSpy).not.toHaveBeenCalled();
    expect(sessionsServiceMock.markWorktreeContextInjected).toHaveBeenCalledWith(7);
    expect(touchSpy).toHaveBeenCalledWith(1, '/tmp/worktree-d');
  });

  it('falls back to snapshot lookup when no context sentence is provided', async () => {
    sessionsServiceMock.findOne.mockResolvedValue({
      id: 7,
      repoId: 1,
      worktreePath: '/tmp/worktree-e',
      hasInjectedWorktreeContext: false,
    });
    sessionsServiceMock.markWorktreeContextInjected.mockResolvedValue({});
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({
      repoId: 1,
      worktreePath: '/tmp/worktree-e',
      contextSentence: 'Snapshot sentence.',
      rootRef: 'origin/main',
      generationStatus: 'ready',
      generatedAt: '2026-04-24T08:00:00.000Z',
      lastUsedAt: null,
      canGenerate: true,
      hasChanges: true,
      usingRepoDefaultRootRef: true,
      errorMessage: null,
      hasRecord: true,
    });
    const touchSpy = jest.spyOn(service as any, 'touchLastUsed').mockResolvedValue(undefined);

    const result = await service.consumeForSession(7);

    expect(result).toEqual({
      shouldInject: true,
      contextSentence: 'Snapshot sentence.',
    });
    expect(service.getSnapshot).toHaveBeenCalledWith(1, '/tmp/worktree-e');
    expect(sessionsServiceMock.markWorktreeContextInjected).toHaveBeenCalledWith(7);
    expect(touchSpy).toHaveBeenCalledWith(1, '/tmp/worktree-e');
  });

  it('does not mark or refetch when consume is disabled or already injected', async () => {
    sessionsServiceMock.findOne.mockResolvedValueOnce({
      id: 7,
      repoId: 1,
      worktreePath: '/tmp/worktree-f',
      hasInjectedWorktreeContext: false,
    });
    const getSnapshotSpy = jest.spyOn(service, 'getSnapshot');

    await expect(
      service.consumeForSession(7, false, 'Provided sentence.'),
    ).resolves.toEqual({
      shouldInject: false,
      contextSentence: null,
    });

    sessionsServiceMock.findOne.mockResolvedValueOnce({
      id: 8,
      repoId: 1,
      worktreePath: '/tmp/worktree-g',
      hasInjectedWorktreeContext: true,
    });

    await expect(
      service.consumeForSession(8, true, 'Provided sentence.'),
    ).resolves.toEqual({
      shouldInject: false,
      contextSentence: null,
    });

    expect(getSnapshotSpy).not.toHaveBeenCalled();
    expect(sessionsServiceMock.markWorktreeContextInjected).not.toHaveBeenCalled();
  });
});
