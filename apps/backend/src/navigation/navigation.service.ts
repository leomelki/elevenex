import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

export interface SessionInTree {
  id: number;
  name: string | null;
  status: string;
  branchName: string;
  repoId: number;
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: string | null;
  lastStateChangeAt: string | null;
}

export interface BranchInTree {
  name: string;
  commit: string;
  label: string;
  current: boolean;
  hasWorktree: boolean;
  worktreePath: string | null;
  sessions: SessionInTree[];
}

export interface RepoInTree {
  id: number;
  name: string;
  path: string;
  color?: string | null;
  error?: boolean;
  errorMessage?: string;
  branches: BranchInTree[];
}

export interface ProjectInTree {
  id: number;
  name: string;
  repos: RepoInTree[];
}

@Injectable()
export class NavigationService {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly reposService: ReposService,
    private readonly branchesService: BranchesService,
    private readonly sessionsService: SessionsService,
  ) {}

  async getNavigationTreeLight(): Promise<ProjectInTree[]> {
    const projects = await this.projectsService.findAll();

    const tree = await Promise.all(
      projects.map(async (project) => {
        const repos = await this.reposService.findByProject(project.id);

        const reposWithSessions = await Promise.all(
          repos.map(async (repo) => {
            const sessions = await this.sessionsService.findByRepo(repo.id);

            // Group non-archived sessions by branchName to create virtual branches
            const branchMap = new Map<string, { worktreePath: string; sessions: SessionInTree[] }>();
            for (const s of sessions) {
              if (s.status === 'archived') continue;
              let entry = branchMap.get(s.branchName);
              if (!entry) {
                entry = { worktreePath: s.worktreePath, sessions: [] };
                branchMap.set(s.branchName, entry);
              }
              entry.sessions.push({
                id: s.id,
                name: s.name,
                status: s.status,
                branchName: s.branchName,
                repoId: repo.id,
                hasUnreviewedCompletion: s.hasUnreviewedCompletion,
                lastCompletionAt: s.lastCompletionAt,
                lastCompletionKind: s.lastCompletionKind,
                lastStateChangeAt: s.lastStateChangeAt,
              });
            }

            const branches: BranchInTree[] = Array.from(branchMap.entries()).map(
              ([branchName, { worktreePath, sessions: branchSessions }]) => ({
                name: branchName,
                commit: '',
                label: '',
                current: false,
                hasWorktree: true,
                worktreePath,
                sessions: branchSessions,
              }),
            );

            return {
              id: repo.id,
              name: repo.name,
              path: repo.path,
              color: repo.color,
              branches,
            };
          }),
        );

        return {
          id: project.id,
          name: project.name,
          repos: reposWithSessions,
        };
      }),
    );

    return tree;
  }

  async getNavigationTree(): Promise<ProjectInTree[]> {
    const projects = await this.projectsService.findAll();

    const tree = await Promise.all(
      projects.map(async (project) => {
        const repos = await this.reposService.findByProject(project.id);

        const reposWithBranches = await Promise.all(
          repos.map(async (repo) => {
            try {
              const [branches, sessions] = await Promise.all([
                this.branchesService.getBranches(repo.path),
                this.sessionsService.findByRepo(repo.id),
              ]);

              // Attach sessions to their corresponding branches
              const branchesWithSessions: BranchInTree[] = branches.map(
                (branch) => {
                  const branchSessions = sessions
                    .filter((s) => s.branchName === branch.name && s.status !== 'archived')
                    .map((s) => ({
                      id: s.id,
                      name: s.name,
                      status: s.status,
                      branchName: s.branchName,
                      repoId: repo.id,
                      hasUnreviewedCompletion: s.hasUnreviewedCompletion,
                      lastCompletionAt: s.lastCompletionAt,
                      lastCompletionKind: s.lastCompletionKind,
                      lastStateChangeAt: s.lastStateChangeAt,
                    }));

                  return {
                    ...branch,
                    sessions: branchSessions,
                  };
                },
              );

              return {
                id: repo.id,
                name: repo.name,
                path: repo.path,
                color: repo.color,
                branches: branchesWithSessions,
              };
            } catch {
              // Handle unreachable repos gracefully
              return {
                id: repo.id,
                name: repo.name,
                path: repo.path,
                color: repo.color,
                error: true,
                errorMessage: 'Path not found',
                branches: [],
              };
            }
          }),
        );

        return {
          id: project.id,
          name: project.name,
          repos: reposWithBranches,
        };
      }),
    );

    return tree;
  }
}
