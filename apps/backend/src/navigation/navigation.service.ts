import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';

export interface SessionInTree {
  id: number;
  name: string | null;
  status: string;
  branchName: string;
  workspaceId: number | null;
  repoId: number;
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: string | null;
  lastStateChangeAt: string | null;
}

export interface WorkspaceInTree {
  id: number;
  name: string;
  path: string;
  isDefault: boolean;
  currentBranch: string | null;
  head: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isMissing: boolean;
  isDirty: boolean;
  branchCheckedOutElsewhere: boolean;
  checkedOutElsewherePath: string | null;
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
  workspaces: WorkspaceInTree[];
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
    private readonly sessionsService: SessionsService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  async getNavigationTreeLight(): Promise<ProjectInTree[]> {
    const projects = await this.projectsService.findAll();

    const tree = await Promise.all(
      projects.map(async (project) => {
        const repos = await this.reposService.findByProject(project.id);

        const reposWithSessions = await Promise.all(
          repos.map(async (repo) => {
            const sessions = await this.sessionsService.findByRepo(repo.id);

            const workspaces = await this.workspacesService.listForRepo(repo);
            const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
            const workspaceMap = new Map<number, WorkspaceInTree>(
              workspaces.map((workspace) => [workspace.id, { ...workspace, sessions: [], archivedSessions: [] }]),
            );

            for (const s of sessions) {
              let entry = s.workspaceId ? workspaceMap.get(s.workspaceId) : undefined;
              if (!entry) {
                const workspace = workspaceByPath.get(s.worktreePath);
                if (workspace) {
                  entry = workspaceMap.get(workspace.id);
                }
              }
              if (!entry) {
                entry = {
                  id: 0 - s.id,
                  name: s.branchName,
                  path: s.worktreePath,
                  isDefault: false,
                  currentBranch: s.branchName,
                  head: null,
                  isDetached: false,
                  isBare: false,
                  isLocked: false,
                  lockReason: null,
                  isMissing: false,
                  isDirty: false,
                  branchCheckedOutElsewhere: false,
                  checkedOutElsewherePath: null,
                  sessions: [],
                  archivedSessions: [],
                };
                workspaceMap.set(entry.id, entry);
              }
              const sessionInTree = {
                id: s.id,
                name: s.name,
                status: s.status,
                branchName: s.branchName,
                workspaceId: s.workspaceId ?? entry.id,
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

            return {
              id: repo.id,
              name: repo.name,
              path: repo.path,
              color: repo.color,
              workspaces: Array.from(workspaceMap.values()),
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
              const [workspaces, sessions] = await Promise.all([
                this.workspacesService.listForRepo(repo),
                this.sessionsService.findByRepo(repo.id),
              ]);

              const workspacesWithSessions: WorkspaceInTree[] = workspaces.map(
                (workspace) => {
                  const workspaceSessions = sessions.filter((s) =>
                    s.workspaceId === workspace.id
                    || (!s.workspaceId && s.worktreePath === workspace.path),
                  );
                  const activeSessions = workspaceSessions
                    .filter((s) => s.status !== 'archived')
                    .map((s) => ({
                      id: s.id,
                      name: s.name,
                      status: s.status,
                      branchName: s.branchName,
                      workspaceId: s.workspaceId ?? workspace.id,
                      repoId: repo.id,
                      hasUnreviewedCompletion: s.hasUnreviewedCompletion,
                      lastCompletionAt: s.lastCompletionAt,
                      lastCompletionKind: s.lastCompletionKind,
                      lastStateChangeAt: s.lastStateChangeAt,
                    }));
                  const archivedSessions = workspaceSessions
                    .filter((s) => s.status === 'archived')
                    .map((s) => ({
                      id: s.id,
                      name: s.name,
                      status: s.status,
                      branchName: s.branchName,
                      workspaceId: s.workspaceId ?? workspace.id,
                      repoId: repo.id,
                      hasUnreviewedCompletion: s.hasUnreviewedCompletion,
                      lastCompletionAt: s.lastCompletionAt,
                      lastCompletionKind: s.lastCompletionKind,
                      lastStateChangeAt: s.lastStateChangeAt,
                    }));

                  return {
                    ...workspace,
                    sessions: activeSessions,
                    archivedSessions,
                  };
                },
              );

              const workspaceSessionIds = new Set(workspacesWithSessions.flatMap((workspace) => [
                ...workspace.sessions,
                ...workspace.archivedSessions,
              ].map((session) => session.id)));
              const archivedOnlyWorkspaces = new Map<string, SessionInTree[]>();
              for (const session of sessions) {
                if (session.status !== 'archived' || workspaceSessionIds.has(session.id)) {
                  continue;
                }
                const entry = archivedOnlyWorkspaces.get(session.worktreePath) ?? [];
                entry.push({
                  id: session.id,
                  name: session.name,
                  status: session.status,
                  branchName: session.branchName,
                  workspaceId: session.workspaceId ?? null,
                  repoId: repo.id,
                  hasUnreviewedCompletion: session.hasUnreviewedCompletion,
                  lastCompletionAt: session.lastCompletionAt,
                  lastCompletionKind: session.lastCompletionKind,
                  lastStateChangeAt: session.lastStateChangeAt,
                });
                archivedOnlyWorkspaces.set(session.worktreePath, entry);
              }

              for (const [worktreePath, archivedSessions] of archivedOnlyWorkspaces) {
                workspacesWithSessions.push({
                  id: 0 - archivedSessions[0].id,
                  name: archivedSessions[0].branchName,
                  path: worktreePath,
                  isDefault: false,
                  currentBranch: archivedSessions[0].branchName,
                  head: null,
                  isDetached: false,
                  isBare: false,
                  isLocked: false,
                  lockReason: null,
                  isMissing: false,
                  isDirty: false,
                  branchCheckedOutElsewhere: false,
                  checkedOutElsewherePath: null,
                  sessions: [],
                  archivedSessions,
                });
              }

              return {
                id: repo.id,
                name: repo.name,
                path: repo.path,
                color: repo.color,
                workspaces: workspacesWithSessions,
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
                workspaces: [],
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
