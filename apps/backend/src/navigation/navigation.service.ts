import { Injectable } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { SessionFoldersService } from '../sessions/session-folders.service.js';

export interface SessionInTree {
  id: number;
  name: string | null;
  status: string;
  branchName: string;
  workspaceId: number | null;
  repoId: number;
  folderId: number | null;
  isTemporary: boolean;
  archivedByFolder: boolean;
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: string | null;
  lastStateChangeAt: string | null;
}

export interface SessionFolderInTree {
  id: number;
  name: string;
  repoId: number;
  workspaceId: number;
  archivedAt: string | null;
  sessions: SessionInTree[];
  archivedSessions: SessionInTree[];
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
  hasConflicts: boolean;
  linkStatus: 'linked' | 'unlinked';
  desiredBranch: string | null;
  unlinkedAt: string | null;
  unlinkedByProjectId: number | null;
  pendingStashCommit: string | null;
  pendingStashMessage: string | null;
  pendingStashCreatedAt: string | null;
  pendingStashStatus: 'pending' | 'applied' | 'apply_conflicted' | null;
  branchCheckedOutElsewhere: boolean;
  checkedOutElsewherePath: string | null;
  sessions: SessionInTree[];
  temporarySessions: SessionInTree[];
  archivedSessions: SessionInTree[];
  sessionFolders: SessionFolderInTree[];
  archivedSessionFolders: SessionFolderInTree[];
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
  workspaces: WorkspaceInTree[];
  branches: BranchInTree[];
}

export interface ProjectInTree {
  id: number;
  name: string;
  repos: RepoInTree[];
}

@Injectable()
export class NavigationService {
  private fullTreeInFlight: Promise<ProjectInTree[]> | null = null;

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly reposService: ReposService,
    private readonly sessionsService: SessionsService,
    private readonly workspacesService: WorkspacesService,
    private readonly sessionFoldersService: SessionFoldersService,
  ) {}

  async getNavigationTreeLight(): Promise<ProjectInTree[]> {
    const projects = await this.projectsService.findAll();

    const tree = await Promise.all(
      projects.map(async (project) => {
        const repos = await this.reposService.findByProject(project.id);

        const reposWithSessions = await Promise.all(
          repos.map(async (repo) => {
            const [workspaces, sessions, folders] = await Promise.all([
              this.workspacesService.listCachedForRepo(repo),
              this.sessionsService.findByRepo(repo.id),
              this.sessionFoldersService.listByRepo(repo.id),
            ]);
            const workspacesWithSessions = this.attachSessionsToWorkspaces(
              repo.id,
              workspaces,
              sessions,
              folders,
            );

            return {
              id: repo.id,
              name: repo.name,
              path: repo.path,
              color: repo.color,
              workspaces: workspacesWithSessions,
              branches: this.toCompatibilityBranches(workspacesWithSessions),
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
    if (this.fullTreeInFlight) {
      return this.fullTreeInFlight;
    }

    this.fullTreeInFlight = this.buildNavigationTree();
    try {
      return await this.fullTreeInFlight;
    } finally {
      this.fullTreeInFlight = null;
    }
  }

  private async buildNavigationTree(): Promise<ProjectInTree[]> {
    const projects = await this.projectsService.findAll();

    const tree = await Promise.all(
      projects.map(async (project) => {
        const repos = await this.reposService.findByProject(project.id);

        const reposWithBranches = await Promise.all(
          repos.map(async (repo) => {
            try {
              const [workspaces, sessions, folders] = await Promise.all([
                this.workspacesService.listForRepo(repo),
                this.sessionsService.findByRepo(repo.id),
                this.sessionFoldersService.listByRepo(repo.id),
              ]);

              const workspacesWithSessions = this.attachSessionsToWorkspaces(
                repo.id,
                workspaces,
                sessions,
                folders,
              );

              return {
                id: repo.id,
                name: repo.name,
                path: repo.path,
                color: repo.color,
                workspaces: workspacesWithSessions,
                branches: this.toCompatibilityBranches(workspacesWithSessions),
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

  private attachSessionsToWorkspaces(
    repoId: number,
    workspaces: Omit<
      WorkspaceInTree,
      | 'sessions'
      | 'temporarySessions'
      | 'archivedSessions'
      | 'sessionFolders'
      | 'archivedSessionFolders'
    >[],
    sessions: Awaited<ReturnType<SessionsService['findByRepo']>>,
    folders: Awaited<ReturnType<SessionFoldersService['listByRepo']>>,
  ): WorkspaceInTree[] {
    const workspaceMap = new Map<number, WorkspaceInTree>(
      workspaces.map((workspace) => [
        workspace.id,
        {
          ...workspace,
          sessions: [],
          temporarySessions: [],
          archivedSessions: [],
          sessionFolders: [],
          archivedSessionFolders: [],
        },
      ]),
    );
    const workspaceByPath = new Map<string, WorkspaceInTree>();
    for (const workspace of workspaceMap.values()) {
      workspaceByPath.set(workspace.path, workspace);
    }

    const virtualWorkspaceByPath = new Map<string, WorkspaceInTree>();
    const folderMap = new Map<number, SessionFolderInTree>();
    for (const folder of folders) {
      const workspace = workspaceMap.get(folder.workspaceId);
      if (!workspace) continue;
      const item: SessionFolderInTree = {
        ...folder,
        sessions: [],
        archivedSessions: [],
      };
      folderMap.set(folder.id, item);
      (folder.archivedAt
        ? workspace.archivedSessionFolders
        : workspace.sessionFolders
      ).push(item);
    }

    for (const session of sessions) {
      const entry =
        (session.workspaceId
          ? workspaceMap.get(session.workspaceId)
          : undefined) ??
        workspaceByPath.get(session.worktreePath) ??
        this.getOrCreateVirtualWorkspace(
          repoId,
          session,
          virtualWorkspaceByPath,
        );

      const sessionInTree: SessionInTree = {
        id: session.id,
        name: session.name,
        status: session.status,
        branchName: session.branchName,
        workspaceId: entry.id > 0 ? entry.id : null,
        repoId,
        folderId: session.folderId,
        isTemporary: session.isTemporary,
        archivedByFolder: session.archivedByFolder,
        hasUnreviewedCompletion: session.hasUnreviewedCompletion,
        lastCompletionAt: session.lastCompletionAt,
        lastCompletionKind: session.lastCompletionKind,
        lastStateChangeAt: session.lastStateChangeAt,
      };

      if (!entry.currentBranch && session.branchName) {
        entry.currentBranch = session.branchName;
      }

      const folder = session.folderId
        ? folderMap.get(session.folderId)
        : undefined;
      if (session.isTemporary) {
        entry.temporarySessions.push(sessionInTree);
      } else if (session.status === 'archived') {
        (folder?.archivedSessions ?? entry.archivedSessions).push(
          sessionInTree,
        );
      } else {
        (folder?.sessions ?? entry.sessions).push(sessionInTree);
      }
    }

    for (const workspace of workspaceMap.values()) {
      workspace.sessionFolders.sort((a, b) => a.name.localeCompare(b.name));
      workspace.archivedSessionFolders.sort((a, b) => a.name.localeCompare(b.name));
    }

    return [
      ...Array.from(workspaceMap.values()),
      ...Array.from(virtualWorkspaceByPath.values()),
    ].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  private getOrCreateVirtualWorkspace(
    repoId: number,
    session: Awaited<ReturnType<SessionsService['findByRepo']>>[number],
    virtualWorkspaceByPath: Map<string, WorkspaceInTree>,
  ): WorkspaceInTree {
    const existing = virtualWorkspaceByPath.get(session.worktreePath);
    if (existing) {
      return existing;
    }

    const workspace: WorkspaceInTree = {
      id: this.virtualWorkspaceId(repoId, session.worktreePath),
      name: session.branchName,
      path: session.worktreePath,
      isDefault: false,
      currentBranch: session.branchName,
      head: null,
      isDetached: false,
      isBare: false,
      isLocked: false,
      lockReason: null,
      isMissing: false,
      isDirty: false,
      hasConflicts: false,
      linkStatus: 'linked',
      desiredBranch: null,
      unlinkedAt: null,
      unlinkedByProjectId: null,
      pendingStashCommit: null,
      pendingStashMessage: null,
      pendingStashCreatedAt: null,
      pendingStashStatus: null,
      branchCheckedOutElsewhere: false,
      checkedOutElsewherePath: null,
      sessions: [],
      temporarySessions: [],
      archivedSessions: [],
      sessionFolders: [],
      archivedSessionFolders: [],
    };

    virtualWorkspaceByPath.set(session.worktreePath, workspace);
    return workspace;
  }

  private virtualWorkspaceId(repoId: number, worktreePath: string): number {
    let hash = 0;
    for (const char of `${repoId}:${worktreePath}`) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return -Math.max(1, Math.abs(hash));
  }

  private toCompatibilityBranches(
    workspaces: WorkspaceInTree[],
  ): BranchInTree[] {
    return workspaces.map((workspace) => ({
      name: workspace.currentBranch ?? workspace.name,
      commit: workspace.head ?? '',
      label: workspace.currentBranch ?? workspace.name,
      current: workspace.isDefault,
      hasWorktree: !workspace.isMissing,
      worktreePath: workspace.path,
      sessions: workspace.sessions,
      archivedSessions: workspace.archivedSessions,
    }));
  }
}
