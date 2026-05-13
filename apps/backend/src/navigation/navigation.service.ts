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
  archivedSessions: SessionInTree[];
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

            // Group sessions by branchName to create virtual branches.
            const branchMap = new Map<string, { worktreePath: string; sessions: SessionInTree[]; archivedSessions: SessionInTree[] }>();
            for (const s of sessions) {
              let entry = branchMap.get(s.branchName);
              if (!entry) {
                entry = { worktreePath: s.worktreePath, sessions: [], archivedSessions: [] };
                branchMap.set(s.branchName, entry);
              }
              const sessionInTree = {
                id: s.id,
                name: s.name,
                status: s.status,
                branchName: s.branchName,
                repoId: repo.id,
                hasUnreviewedCompletion: s.hasUnreviewedCompletion,
                lastCompletionAt: s.lastCompletionAt,
                lastCompletionKind: s.lastCompletionKind,
                lastStateChangeAt: s.lastStateChangeAt,
              };
              if (s.status === 'archived') {
                entry.archivedSessions.push(sessionInTree);
              } else {
                entry.sessions.push(sessionInTree);
              }
            }

            const branches: BranchInTree[] = Array.from(branchMap.entries()).map(
              ([branchName, { worktreePath, sessions: branchSessions, archivedSessions }]) => ({
                name: branchName,
                commit: '',
                label: '',
                current: false,
                hasWorktree: true,
                worktreePath,
                sessions: branchSessions,
                archivedSessions,
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
                  const branchSessions = sessions.filter((s) => s.branchName === branch.name);
                  const activeSessions = branchSessions
                    .filter((s) => s.status !== 'archived')
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
                  const archivedSessions = branchSessions
                    .filter((s) => s.status === 'archived')
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
                    sessions: activeSessions,
                    archivedSessions,
                  };
                },
              );

              const branchNames = new Set(branches.map((branch) => branch.name));
              const archivedOnlyBranches = new Map<string, SessionInTree[]>();
              for (const session of sessions) {
                if (session.status !== 'archived' || branchNames.has(session.branchName)) {
                  continue;
                }
                const entry = archivedOnlyBranches.get(session.branchName) ?? [];
                entry.push({
                  id: session.id,
                  name: session.name,
                  status: session.status,
                  branchName: session.branchName,
                  repoId: repo.id,
                  hasUnreviewedCompletion: session.hasUnreviewedCompletion,
                  lastCompletionAt: session.lastCompletionAt,
                  lastCompletionKind: session.lastCompletionKind,
                  lastStateChangeAt: session.lastStateChangeAt,
                });
                archivedOnlyBranches.set(session.branchName, entry);
              }

              for (const [branchName, archivedSessions] of archivedOnlyBranches) {
                branchesWithSessions.push({
                  name: branchName,
                  commit: '',
                  label: branchName,
                  current: false,
                  hasWorktree: true,
                  worktreePath: null,
                  sessions: [],
                  archivedSessions,
                });
              }

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
