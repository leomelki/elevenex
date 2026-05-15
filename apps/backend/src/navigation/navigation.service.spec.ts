import { Test, TestingModule } from '@nestjs/testing';
import { NavigationService } from './navigation.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import {
  WorkspacesService,
  WorkspaceSnapshot,
} from '../workspaces/workspaces.service.js';

describe('NavigationService', () => {
  let service: NavigationService;
  let mockProjectsService: jest.Mocked<ProjectsService>;
  let mockReposService: jest.Mocked<ReposService>;
  let mockSessionsService: jest.Mocked<SessionsService>;
  let mockWorkspacesService: jest.Mocked<WorkspacesService>;

  const repo = {
    id: 1,
    projectId: 1,
    name: 'repo-1',
    path: '/path/to/repo',
    color: null,
    preferredContextRootRef: null,
    createdAt: '2024-01-01',
  };

  const workspace = (patch: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({
    id: 1,
    repoId: 1,
    name: 'Default',
    path: '/path/to/repo',
    isDefault: true,
    createdFromRef: 'HEAD',
    currentBranch: 'main',
    head: 'abc123',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
    isMissing: false,
    isDirty: false,
    branchCheckedOutElsewhere: false,
    checkedOutElsewherePath: null,
    ...patch,
  });

  const session = (patch: Record<string, unknown>) =>
    ({
      id: 1,
      repoId: 1,
      workspaceId: 1,
      branchName: 'main',
      worktreePath: '/path/to/repo',
      name: 'Session',
      status: 'active',
      activeAgentProvider: 'claude',
      claudeSessionId: '-1',
      codexSessionId: '-1',
      piSessionPath: '-1',
      hasInjectedWorktreeContext: false,
      hasUnreviewedCompletion: false,
      lastCompletionAt: null,
      lastCompletionKind: null,
      lastStateChangeAt: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      ...patch,
    }) as Awaited<ReturnType<SessionsService['findByRepo']>>[number];

  beforeEach(async () => {
    mockProjectsService = {
      findAll: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;
    mockReposService = {
      findByProject: jest.fn(),
    } as unknown as jest.Mocked<ReposService>;
    mockSessionsService = {
      findByRepo: jest.fn(),
    } as unknown as jest.Mocked<SessionsService>;
    mockWorkspacesService = {
      listForRepo: jest.fn(),
      listCachedForRepo: jest.fn(),
    } as unknown as jest.Mocked<WorkspacesService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NavigationService,
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: ReposService, useValue: mockReposService },
        { provide: SessionsService, useValue: mockSessionsService },
        { provide: WorkspacesService, useValue: mockWorkspacesService },
      ],
    }).compile();

    service = module.get<NavigationService>(NavigationService);
  });

  it('returns an empty tree when no projects exist', async () => {
    mockProjectsService.findAll.mockResolvedValue([]);

    await expect(service.getNavigationTree()).resolves.toEqual([]);
  });

  it('groups live and archived sessions under workspaces', async () => {
    mockProjectsService.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'Project 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]);
    mockReposService.findByProject.mockResolvedValue([repo]);
    mockWorkspacesService.listForRepo.mockResolvedValue([
      workspace({
        id: 1,
        name: 'Default',
        path: '/path/to/repo',
        currentBranch: 'main',
      }),
      workspace({
        id: 2,
        name: 'Review',
        path: '/path/review',
        currentBranch: 'feature',
        isDefault: false,
      }),
    ]);
    mockSessionsService.findByRepo.mockResolvedValue([
      session({
        id: 1,
        workspaceId: 1,
        name: 'Live',
        status: 'active',
        branchName: 'main',
        worktreePath: '/path/to/repo',
      }),
      session({
        id: 2,
        workspaceId: 1,
        name: 'Archived',
        status: 'archived',
        branchName: 'main',
        worktreePath: '/path/to/repo',
      }),
      session({
        id: 3,
        workspaceId: 2,
        name: 'Feature',
        status: 'created',
        branchName: 'feature',
        worktreePath: '/path/review',
      }),
    ]);

    const result = await service.getNavigationTree();

    expect(result[0].repos[0].workspaces).toHaveLength(2);
    const defaultWorkspace = result[0].repos[0].workspaces.find(
      (item) => item.name === 'Default',
    );
    const reviewWorkspace = result[0].repos[0].workspaces.find(
      (item) => item.name === 'Review',
    );

    expect(defaultWorkspace?.sessions.map((item) => item.id)).toEqual([1]);
    expect(defaultWorkspace?.archivedSessions.map((item) => item.id)).toEqual([
      2,
    ]);
    expect(defaultWorkspace?.currentBranch).toBe('main');
    expect(reviewWorkspace?.sessions.map((item) => item.id)).toEqual([3]);
    expect(reviewWorkspace?.currentBranch).toBe('feature');
  });

  it('keeps legacy path-based sessions attached when workspaceId is missing', async () => {
    mockProjectsService.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'Project 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]);
    mockReposService.findByProject.mockResolvedValue([repo]);
    mockWorkspacesService.listCachedForRepo.mockResolvedValue([
      workspace({
        id: 2,
        name: 'Legacy',
        path: '/path/legacy',
        currentBranch: 'legacy',
        isDefault: false,
      }),
    ]);
    mockSessionsService.findByRepo.mockResolvedValue([
      session({
        id: 4,
        workspaceId: null,
        branchName: 'legacy',
        worktreePath: '/path/legacy',
      }),
    ]);

    const result = await service.getNavigationTreeLight();

    expect(result[0].repos[0].workspaces[0].sessions[0]).toMatchObject({
      id: 4,
      workspaceId: 2,
      branchName: 'legacy',
    });
  });

  it('groups unmatched legacy sessions by worktree path instead of creating one workspace per session', async () => {
    mockProjectsService.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'Project 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]);
    mockReposService.findByProject.mockResolvedValue([repo]);
    mockWorkspacesService.listCachedForRepo.mockResolvedValue([
      workspace({
        id: 1,
        name: 'Default',
        path: '/path/to/repo',
        currentBranch: 'main',
      }),
    ]);
    mockSessionsService.findByRepo.mockResolvedValue([
      session({
        id: 4,
        workspaceId: null,
        branchName: 'feature',
        worktreePath: '/path/feature',
        name: 'One',
      }),
      session({
        id: 5,
        workspaceId: null,
        branchName: 'feature',
        worktreePath: '/path/feature',
        name: 'Two',
      }),
    ]);

    const result = await service.getNavigationTreeLight();
    const legacyWorkspaces = result[0].repos[0].workspaces.filter(
      (item) => item.path === '/path/feature',
    );

    expect(legacyWorkspaces).toHaveLength(1);
    expect(legacyWorkspaces[0].sessions.map((item) => item.id)).toEqual([4, 5]);
  });

  it('uses cached workspace data for the light tree', async () => {
    mockProjectsService.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'Project 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]);
    mockReposService.findByProject.mockResolvedValue([repo]);
    mockWorkspacesService.listCachedForRepo.mockResolvedValue([
      workspace({
        id: 1,
        name: 'Default',
        path: '/path/to/repo',
        currentBranch: null,
      }),
    ]);
    mockSessionsService.findByRepo.mockResolvedValue([]);

    const result = await service.getNavigationTreeLight();

    expect(mockWorkspacesService.listCachedForRepo).toHaveBeenCalledWith(repo);
    expect(mockWorkspacesService.listForRepo).not.toHaveBeenCalled();
    expect(result[0].repos[0].workspaces[0]).toMatchObject({
      id: 1,
      name: 'Default',
    });
  });

  it('marks repo errors when workspace reconciliation fails', async () => {
    mockProjectsService.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'Project 1',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ]);
    mockReposService.findByProject.mockResolvedValue([repo]);
    mockSessionsService.findByRepo.mockResolvedValue([]);
    mockWorkspacesService.listForRepo.mockRejectedValue(
      new Error('Path not found'),
    );

    const result = await service.getNavigationTree();

    expect(result[0].repos[0]).toMatchObject({
      error: true,
      errorMessage: 'Path not found',
      workspaces: [],
    });
  });
});
