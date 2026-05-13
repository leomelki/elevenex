import { Test, TestingModule } from '@nestjs/testing';
import { NavigationService } from './navigation.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

describe('NavigationService', () => {
  let service: NavigationService;
  let mockProjectsService: jest.Mocked<ProjectsService>;
  let mockReposService: jest.Mocked<ReposService>;
  let mockBranchesService: jest.Mocked<BranchesService>;
  let mockSessionsService: jest.Mocked<SessionsService>;

  beforeEach(async () => {
    mockProjectsService = {
      findAll: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;

    mockReposService = {
      findByProject: jest.fn(),
    } as unknown as jest.Mocked<ReposService>;

    mockBranchesService = {
      getBranches: jest.fn(),
    } as unknown as jest.Mocked<BranchesService>;

    mockSessionsService = {
      findByRepo: jest.fn(),
    } as unknown as jest.Mocked<SessionsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NavigationService,
        { provide: ProjectsService, useValue: mockProjectsService },
        { provide: ReposService, useValue: mockReposService },
        { provide: BranchesService, useValue: mockBranchesService },
        { provide: SessionsService, useValue: mockSessionsService },
      ],
    }).compile();

    service = module.get<NavigationService>(NavigationService);
  });

  describe('getNavigationTreeLight', () => {
    it('separates live and archived sessions under branch context', async () => {
      mockProjectsService.findAll.mockResolvedValue([
        { id: 1, name: 'Project 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      mockReposService.findByProject.mockResolvedValue([
        { id: 1, projectId: 1, name: 'repo-1', path: '/path/to/repo', createdAt: '2024-01-01' },
      ]);

      mockSessionsService.findByRepo.mockResolvedValue([
        { id: 1, repoId: 1, branchName: 'main', worktreePath: '/path/main', name: 'Live', status: 'active', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 2, repoId: 1, branchName: 'main', worktreePath: '/path/main', name: 'Archived', status: 'archived', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 3, repoId: 1, branchName: 'old', worktreePath: '/path/old', name: 'Archived only', status: 'archived', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      const result = await service.getNavigationTreeLight();

      const branches = result[0].repos[0].branches;
      const mainBranch = branches.find(branch => branch.name === 'main');
      const oldBranch = branches.find(branch => branch.name === 'old');

      expect(mainBranch?.sessions.map(session => session.id)).toEqual([1]);
      expect(mainBranch?.archivedSessions.map(session => session.id)).toEqual([2]);
      expect(oldBranch?.sessions).toEqual([]);
      expect(oldBranch?.archivedSessions.map(session => session.id)).toEqual([3]);
    });
  });

  describe('getNavigationTree', () => {
    it('should return empty array when no projects exist', async () => {
      mockProjectsService.findAll.mockResolvedValue([]);

      const result = await service.getNavigationTree();

      expect(result).toEqual([]);
    });

    it('should return correct tree structure with project, repo, branches, and sessions', async () => {
      mockProjectsService.findAll.mockResolvedValue([
        { id: 1, name: 'Project 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      mockReposService.findByProject.mockResolvedValue([
        { id: 1, projectId: 1, name: 'repo-1', path: '/path/to/repo', createdAt: '2024-01-01' },
      ]);

      mockBranchesService.getBranches.mockResolvedValue([
        { name: 'main', commit: 'abc123', label: 'main', current: true, isRemote: false, hasWorktree: false, worktreePath: null },
        { name: 'feature', commit: 'def456', label: 'feature', current: false, isRemote: false, hasWorktree: true, worktreePath: '/path/to/wt' },
      ]);

      mockSessionsService.findByRepo.mockResolvedValue([
        { id: 1, repoId: 1, branchName: 'feature', worktreePath: '/path/to/wt', name: 'Session 1', status: 'active', claudeSessionId: '-1', hasUnreviewedCompletion: true, lastCompletionAt: '2024-01-02', lastCompletionKind: 'completed', lastStateChangeAt: '2024-01-03T10:00:00.000Z', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 2, repoId: 1, branchName: 'main', worktreePath: '/path/to/main-wt', name: 'Session 2', status: 'created', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      const result = await service.getNavigationTree();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('Project 1');
      expect(result[0].repos).toHaveLength(1);

      const repo = result[0].repos[0];
      expect(repo.id).toBe(1);
      expect(repo.name).toBe('repo-1');
      expect(repo.branches).toHaveLength(2);

      const mainBranch = repo.branches.find((b) => b.name === 'main');
      expect(mainBranch?.hasWorktree).toBe(false);
      expect(mainBranch?.sessions).toHaveLength(1);
      expect(mainBranch?.sessions[0].name).toBe('Session 2');
      expect(mainBranch?.sessions[0].status).toBe('created');

      const featureBranch = repo.branches.find((b) => b.name === 'feature');
      expect(featureBranch?.hasWorktree).toBe(true);
      expect(featureBranch?.sessions).toHaveLength(1);
      expect(featureBranch?.sessions[0].name).toBe('Session 1');
      expect(featureBranch?.sessions[0].status).toBe('active');
      expect(featureBranch?.sessions[0].hasUnreviewedCompletion).toBe(true);
      expect(featureBranch?.sessions[0].lastStateChangeAt).toBe('2024-01-03T10:00:00.000Z');
    });

    it('should handle unreachable repo gracefully', async () => {
      mockProjectsService.findAll.mockResolvedValue([
        { id: 1, name: 'Project 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      mockReposService.findByProject.mockResolvedValue([
        { id: 1, projectId: 1, name: 'repo-1', path: '/invalid/path', createdAt: '2024-01-01' },
      ]);

      mockBranchesService.getBranches.mockRejectedValue(new Error('Path not found'));

      mockSessionsService.findByRepo.mockResolvedValue([]);

      const result = await service.getNavigationTree();

      expect(result).toHaveLength(1);
      expect(result[0].repos).toHaveLength(1);

      const repo = result[0].repos[0];
      expect(repo.error).toBe(true);
      expect(repo.errorMessage).toBe('Path not found');
      expect(repo.branches).toEqual([]);
    });

    it('should return sessions attached to correct branches', async () => {
      mockProjectsService.findAll.mockResolvedValue([
        { id: 1, name: 'Project 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      mockReposService.findByProject.mockResolvedValue([
        { id: 1, projectId: 1, name: 'repo-1', path: '/path/to/repo', createdAt: '2024-01-01' },
      ]);

      mockBranchesService.getBranches.mockResolvedValue([
        { name: 'main', commit: 'abc123', label: 'main', current: true, isRemote: false, hasWorktree: false, worktreePath: null },
        { name: 'develop', commit: 'def456', label: 'develop', current: false, isRemote: false, hasWorktree: false, worktreePath: null },
      ]);

      mockSessionsService.findByRepo.mockResolvedValue([
        { id: 1, repoId: 1, branchName: 'main', worktreePath: '/path/wt1', name: 'Main Session', status: 'active', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: '2024-01-03T10:00:00.000Z', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 2, repoId: 1, branchName: 'develop', worktreePath: '/path/wt2', name: 'Dev Session', status: 'archived', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      const result = await service.getNavigationTree();

      const mainBranch = result[0].repos[0].branches.find((b) => b.name === 'main');
      const developBranch = result[0].repos[0].branches.find((b) => b.name === 'develop');

      expect(mainBranch?.sessions).toHaveLength(1);
      expect(mainBranch?.sessions[0].branchName).toBe('main');
      expect(mainBranch?.sessions[0].status).toBe('active');

      // Archived sessions are filtered out from navigation tree
      expect(developBranch?.sessions).toHaveLength(0);
    });

    it('should return sessions with status field for active indicator', async () => {
      mockProjectsService.findAll.mockResolvedValue([
        { id: 1, name: 'Project 1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      mockReposService.findByProject.mockResolvedValue([
        { id: 1, projectId: 1, name: 'repo-1', path: '/path/to/repo', createdAt: '2024-01-01' },
      ]);

      mockBranchesService.getBranches.mockResolvedValue([
        { name: 'main', commit: 'abc123', label: 'main', current: true, isRemote: false, hasWorktree: false, worktreePath: null },
      ]);

      mockSessionsService.findByRepo.mockResolvedValue([
        { id: 1, repoId: 1, branchName: 'main', worktreePath: '/path/wt', name: 'Active Session', status: 'active', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: '2024-01-03T10:00:00.000Z', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 2, repoId: 1, branchName: 'main', worktreePath: '/path/wt2', name: 'Created Session', status: 'created', claudeSessionId: '-1', hasUnreviewedCompletion: false, lastCompletionAt: null, lastCompletionKind: null, lastStateChangeAt: null, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      const result = await service.getNavigationTree();

      const mainBranch = result[0].repos[0].branches[0];
      expect(mainBranch.sessions).toHaveLength(2);

      const activeSession = mainBranch.sessions.find((s) => s.status === 'active');
      const createdSession = mainBranch.sessions.find((s) => s.status === 'created');

      expect(activeSession?.status).toBe('active');
      expect(createdSession?.status).toBe('created');
    });
  });
});
