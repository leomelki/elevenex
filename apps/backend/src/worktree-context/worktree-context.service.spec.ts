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
}));

describe('WorktreeContextService', () => {
  let service: WorktreeContextService;

  beforeEach(async () => {
    jest.clearAllMocks();

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
          useValue: {
            findOne: jest.fn(),
            markWorktreeContextInjected: jest.fn(),
          },
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

    (simpleGit as jest.Mock).mockReturnValue({ raw, log });

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
});
