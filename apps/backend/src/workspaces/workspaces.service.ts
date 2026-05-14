import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { WorktreeInfo, WorktreesService } from '../worktrees/worktrees.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

export interface WorkspaceSnapshot {
  id: number;
  repoId: number;
  name: string;
  path: string;
  isDefault: boolean;
  createdFromRef: string | null;
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
}

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly worktreesService: WorktreesService,
    private readonly sessionsService: SessionsService,
  ) {}

  async ensureDefaultWorkspace(repo: typeof schema.repos.$inferSelect) {
    const existing = await this.findDefault(repo.id);
    if (existing) {
      return existing;
    }

    const rows = await this.db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'Default',
        path: repo.path,
        isDefault: true,
        createdFromRef: 'HEAD',
      })
      .returning();

    await this.backfillSessionsForWorkspace(repo.id, rows[0].id, repo.path);
    return rows[0];
  }

  async listForRepo(repo: typeof schema.repos.$inferSelect): Promise<WorkspaceSnapshot[]> {
    await this.ensureDefaultWorkspace(repo);
    await this.reconcileGitWorktrees(repo);
    await this.reconcileSessionWorktrees(repo);

    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repo.id));

    const gitWorktrees = await this.safeListWorktrees(repo.path);
    const byRealPath = await this.indexWorktreesByRealPath(gitWorktrees);

    const snapshots = await Promise.all(rows.map(async (workspace) => {
      const key = await this.realPathOrRaw(workspace.path);
      const gitInfo = byRealPath.get(key) ?? null;
      const isMissing = !gitInfo && !fs.existsSync(workspace.path);
      const currentBranch = gitInfo?.branch ?? await this.getCurrentBranch(workspace.path);
      const isDirty = !isMissing && await this.isDirty(workspace.path);
      const checkedOutElsewhere = currentBranch
        ? await this.findBranchWorktreePath(repo.path, currentBranch, workspace.path)
        : null;

      return {
        id: workspace.id,
        repoId: workspace.repoId,
        name: workspace.name,
        path: workspace.path,
        isDefault: workspace.isDefault,
        createdFromRef: workspace.createdFromRef,
        currentBranch,
        head: gitInfo?.head ?? null,
        isDetached: gitInfo?.isDetached ?? currentBranch === null,
        isBare: gitInfo?.isBare ?? false,
        isLocked: gitInfo?.isLocked ?? false,
        lockReason: gitInfo?.lockReason ?? null,
        isMissing,
        isDirty,
        branchCheckedOutElsewhere: checkedOutElsewhere !== null,
        checkedOutElsewherePath: checkedOutElsewhere,
      };
    }));

    return snapshots.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Workspace with id ${id} not found`);
    }

    return rows[0];
  }

  async createWorkspace(
    repo: typeof schema.repos.$inferSelect,
    input: {
      name: string;
      path?: string;
      startPoint?: string;
      createBranch?: boolean;
      branchName?: string;
    },
  ) {
    const name = this.normalizeName(input.name);
    const startPoint = input.startPoint?.trim() || 'HEAD';
    const workspacePath = input.path?.trim()
      || path.join(path.dirname(repo.path), '.worktrees', repo.name, this.slugify(name));
    const git = worktreeSimpleGit(repo.path);

    if (fs.existsSync(workspacePath)) {
      throw new ConflictException('A folder already exists at this workspace path.');
    }

    const branchName = input.branchName?.trim();
    const args = ['worktree', 'add', workspacePath];
    if (input.createBranch && branchName) {
      this.assertValidBranchName(branchName);
      args.push('-b', branchName, startPoint);
    } else {
      args.push(startPoint);
    }

    try {
      await git.raw(args);
    } catch (error) {
      throw this.gitError('Could not create workspace', error);
    }

    const rows = await this.insertWorkspace({
      repoId: repo.id,
      name,
      path: workspacePath,
      isDefault: false,
      createdFromRef: input.createBranch && branchName ? branchName : startPoint,
    });

    return rows[0];
  }

  async renameWorkspace(id: number, name: string) {
    const workspace = await this.findOne(id);
    const rows = await this.db
      .update(schema.workspaces)
      .set({ name: this.normalizeName(name), updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.id, workspace.id))
      .returning();
    return rows[0];
  }

  async switchBranch(id: number, branchName: string, force = false) {
    const workspace = await this.findOne(id);
    const repo = await this.findRepo(workspace.repoId);
    const branch = branchName.trim();
    if (!branch) {
      throw new BadRequestException('Branch name is required');
    }

    const dirty = await this.isDirty(workspace.path);
    if (dirty && !force) {
      throw new BadRequestException('Workspace has uncommitted changes. Confirm before switching branches.');
    }

    const checkedOutPath = await this.findBranchWorktreePath(repo.path, branch, workspace.path);
    if (checkedOutPath) {
      throw new ConflictException(`Branch "${branch}" is already checked out at ${checkedOutPath}`);
    }

    try {
      await worktreeSimpleGit(workspace.path).raw(['checkout', branch]);
    } catch (error) {
      throw this.gitError('Could not switch branch', error);
    }

    await this.updateSessionsBranch(workspace.id, branch);
    return this.findOne(id);
  }

  async createBranch(
    workspaceId: number,
    input: {
      branchName: string;
      startPoint?: string;
      destination: 'current-workspace' | 'new-workspace' | 'branch-only';
      workspaceName?: string;
      workspacePath?: string;
    },
  ) {
    const workspace = await this.findOne(workspaceId);
    const repo = await this.findRepo(workspace.repoId);
    const branchName = input.branchName.trim();
    this.assertValidBranchName(branchName);
    const startPoint = input.startPoint?.trim() || 'HEAD';

    if (input.destination === 'branch-only') {
      try {
        await worktreeSimpleGit(repo.path).branch([branchName, startPoint]);
      } catch (error) {
        throw this.gitError('Could not create branch', error);
      }
      return { branchName, workspace: null };
    }

    if (input.destination === 'new-workspace') {
      const nextWorkspace = await this.createWorkspace(repo, {
        name: input.workspaceName?.trim() || branchName,
        path: input.workspacePath,
        startPoint,
        createBranch: true,
        branchName,
      });
      return { branchName, workspace: nextWorkspace };
    }

    const dirty = await this.isDirty(workspace.path);
    if (dirty) {
      throw new BadRequestException('Workspace has uncommitted changes. Create a new workspace or clean it before checking out a new branch.');
    }

    try {
      await worktreeSimpleGit(workspace.path).checkoutBranch(branchName, startPoint);
    } catch (error) {
      throw this.gitError('Could not create branch', error);
    }

    await this.updateSessionsBranch(workspace.id, branchName);
    return { branchName, workspace: await this.findOne(workspace.id) };
  }

  async deleteWorkspace(id: number, removeFromDisk: boolean) {
    const workspace = await this.findOne(id);
    if (workspace.isDefault && removeFromDisk) {
      throw new BadRequestException('The default workspace cannot be deleted from disk.');
    }
    if (workspace.isDefault) {
      throw new BadRequestException('The default workspace cannot be removed from the project.');
    }

    const repo = await this.findRepo(workspace.repoId);
    if (removeFromDisk) {
      await this.worktreesService.removeWorktree(repo.path, workspace.path);
    }

    await this.sessionsService.deleteByRepoAndWorktreePath(workspace.repoId, workspace.path);

    await this.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));

    return { success: true };
  }

  async backfillSessionsForWorkspace(repoId: number, workspaceId: number, worktreePath: string) {
    await this.db
      .update(schema.sessions)
      .set({ workspaceId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.worktreePath, worktreePath),
        ),
      );
  }

  private async reconcileGitWorktrees(repo: typeof schema.repos.$inferSelect) {
    const existing = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repo.id));
    const byPath = new Map(existing.map((workspace) => [workspace.path, workspace]));

    for (const worktree of await this.safeListWorktrees(repo.path)) {
      if (byPath.has(worktree.path)) {
        const workspace = byPath.get(worktree.path)!;
        await this.backfillSessionsForWorkspace(repo.id, workspace.id, workspace.path);
        continue;
      }

      const name = await this.uniqueWorkspaceName(repo.id, this.nameFromWorktree(repo, worktree));
      const rows = await this.insertWorkspace({
        repoId: repo.id,
        name,
        path: worktree.path,
        isDefault: await this.samePath(worktree.path, repo.path),
        createdFromRef: worktree.branch ?? worktree.head,
      });
      await this.backfillSessionsForWorkspace(repo.id, rows[0].id, worktree.path);
    }
  }

  private async reconcileSessionWorktrees(repo: typeof schema.repos.$inferSelect) {
    const [existing, sessions] = await Promise.all([
      this.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.repoId, repo.id)),
      this.sessionsService.findByRepo(repo.id),
    ]);
    const workspaceByPath = new Map(existing.map((workspace) => [workspace.path, workspace]));
    const sessionsByPath = new Map<string, Awaited<ReturnType<SessionsService['findByRepo']>>>();

    for (const session of sessions) {
      if (workspaceByPath.has(session.worktreePath)) {
        continue;
      }
      const entry = sessionsByPath.get(session.worktreePath) ?? [];
      entry.push(session);
      sessionsByPath.set(session.worktreePath, entry);
    }

    for (const [worktreePath, pathSessions] of sessionsByPath) {
      const first = pathSessions[0];
      const name = await this.uniqueWorkspaceName(
        repo.id,
        first.branchName || path.basename(worktreePath),
      );
      const rows = await this.insertWorkspace({
        repoId: repo.id,
        name,
        path: worktreePath,
        isDefault: await this.samePath(worktreePath, repo.path),
        createdFromRef: first.branchName,
      });
      workspaceByPath.set(worktreePath, rows[0]);
      await this.backfillSessionsForWorkspace(repo.id, rows[0].id, worktreePath);
    }
  }

  private async insertWorkspace(values: typeof schema.workspaces.$inferInsert) {
    try {
      return await this.db.insert(schema.workspaces).values(values).returning();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictException('A workspace with this name or path already exists.');
      }
      throw error;
    }
  }

  private async findRepo(repoId: number) {
    const rows = await this.db.select().from(schema.repos).where(eq(schema.repos.id, repoId));
    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${repoId} not found`);
    }
    return rows[0];
  }

  private async findDefault(repoId: number) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(and(eq(schema.workspaces.repoId, repoId), eq(schema.workspaces.isDefault, true)));
    return rows[0] ?? null;
  }

  private async safeListWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    try {
      return await this.worktreesService.listWorktrees(repoPath);
    } catch {
      return [];
    }
  }

  private async indexWorktreesByRealPath(worktrees: WorktreeInfo[]) {
    const result = new Map<string, WorktreeInfo>();
    for (const worktree of worktrees) {
      result.set(await this.realPathOrRaw(worktree.path), worktree);
    }
    return result;
  }

  private async getCurrentBranch(workspacePath: string): Promise<string | null> {
    if (!fs.existsSync(workspacePath)) {
      return null;
    }
    try {
      const branch = await worktreeSimpleGit(workspacePath).revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim() === 'HEAD' ? null : branch.trim();
    } catch {
      return null;
    }
  }

  private async isDirty(workspacePath: string): Promise<boolean> {
    if (!fs.existsSync(workspacePath)) {
      return false;
    }
    try {
      const status = await worktreeSimpleGit(workspacePath).status();
      return !status.isClean();
    } catch {
      return false;
    }
  }

  private async findBranchWorktreePath(repoPath: string, branchName: string, currentPath: string): Promise<string | null> {
    for (const worktree of await this.safeListWorktrees(repoPath)) {
      if (worktree.branch !== branchName) continue;
      if (await this.samePath(worktree.path, currentPath)) continue;
      return worktree.path;
    }
    return null;
  }

  private async updateSessionsBranch(workspaceId: number, branchName: string) {
    await this.db
      .update(schema.sessions)
      .set({ branchName, updatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.workspaceId, workspaceId));
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new BadRequestException('Workspace name is required');
    }
    return normalized;
  }

  private slugify(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  }

  private assertValidBranchName(name: string) {
    if (!name || /^[.-]/.test(name) || /[\s~^:?*[\\]/.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
      throw new BadRequestException(`Invalid branch name: "${name}"`);
    }
  }

  private nameFromWorktree(repo: typeof schema.repos.$inferSelect, worktree: WorktreeInfo): string {
    if (worktree.path === repo.path) return 'Default';
    return worktree.branch ?? path.basename(worktree.path);
  }

  private async uniqueWorkspaceName(repoId: number, baseName: string): Promise<string> {
    const existing = await this.db.select().from(schema.workspaces).where(eq(schema.workspaces.repoId, repoId));
    const names = new Set(existing.map((workspace) => workspace.name.toLowerCase()));
    let candidate = baseName || 'Workspace';
    let index = 2;
    while (names.has(candidate.toLowerCase())) {
      candidate = `${baseName} ${index}`;
      index += 1;
    }
    return candidate;
  }

  private async samePath(a: string, b: string): Promise<boolean> {
    return await this.realPathOrRaw(a) === await this.realPathOrRaw(b);
  }

  private async realPathOrRaw(value: string): Promise<string> {
    try {
      return await fs.promises.realpath(value);
    } catch {
      return path.resolve(value);
    }
  }

  private gitError(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new BadRequestException(`${prefix}: ${message}`);
  }
}
