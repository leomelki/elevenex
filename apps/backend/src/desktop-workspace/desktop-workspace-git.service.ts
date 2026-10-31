import { commitSnapshot } from './desktop-commit.js';
import { commitSelection, commitRevision } from './desktop-commit-selection.js';
import { CommitPreviewReader, previewCommit } from './desktop-commit-preview.js';
import { DesktopWorkspaceActivityService } from './desktop-workspace-activity.service.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { and, eq, isNull, ne, count } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { GitService } from '../git/git.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { workspaceBody } from './desktop-workspace.service.js';
import { ProjectsService } from '../projects/projects.service.js';

export interface WorkspaceGitInput {
  type?: unknown;
  message?: unknown;
  branchName?: unknown;
  selection?: unknown;
  revision?: unknown;
  push?: unknown;
}
@Injectable()
export class DesktopWorkspaceGitService {
  private readonly previewReader = new CommitPreviewReader();
  onModuleDestroy(): void { this.previewReader.clear(); }
  private readonly phases = new Map<number, 'writing' | 'committing' | 'pushing'>();
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly git: GitService,
    private readonly taskGit: TaskGitService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    @Optional() private readonly activity?: DesktopWorkspaceActivityService,
  ) {}
  private async readyTask(id: number) {
    const task = await this.tasks.record(id);
    if (
      task.taskState !== 'ready' ||
      task.linkStatus !== 'linked' ||
      !task.path
    )
      throw new ConflictException('Task worktree is unavailable.');
    return task;
  }
  async summary(id: number) {
    const task = await this.readyTask(id);
    const status = await this.git.getStatusSummary(task.path);
    const localAhead =
      !status.upstream &&
      task.startingCommit &&
      /^[a-f0-9]{40,64}$/.test(task.startingCommit)
        ? Number(
            (
              await worktreeSimpleGit(task.path).raw([
                'rev-list',
                '--count',
                `${task.startingCommit}..HEAD`,
              ])
            ).trim(),
          )
        : status.ahead;
    if (!Number.isSafeInteger(localAhead) || localAhead < 0)
      throw new ConflictException('Could not read local commit count.');
    return {
      taskId: id,
      branch: status.branch,
      upstream: status.upstream,
      ahead: localAhead,
      behind: status.behind,
      files: status.total.files,
      additions: status.total.additions,
      deletions: status.total.deletions,
      ...(this.phases.has(id) ? { commitPhase: this.phases.get(id) } : {}),
      conflicted: status.files.some((file) => file.status === 'conflicted'),
      ...(status.changesRevision ? { changesRevision: status.changesRevision } : {}),
    };
  }
  async closePreview(id: number) {
    const task = await this.tasks.record(id);
    const [preview, rows, git] = await Promise.all([
      this.tasks.finishPreview(id),
      this.db
        .select({ count: count() })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, id),
            eq(schema.sessions.surface, 'session'),
            ne(schema.sessions.status, 'archived'),
          ),
        ),
      task.taskState === 'ready' && task.linkStatus === 'linked'
        ? this.summary(id)
        : Promise.resolve(null),
    ]);
    return {
      taskId: id,
      sessions: rows[0].count,
      running: preview.agents,
      terminals: preview.terminals,
      actions: preview.actions,
      unpushed: git?.ahead ?? 0,
      uncommitted: git?.files ?? 0,
    };
  }
  async commitPreview(id: number, input: Record<string, unknown>) {
    const selection = commitSelection(input);
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096)) throw new BadRequestException('Invalid file filter.');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^[1-9]\d{0,8}$/.test(input.cursor))) throw new BadRequestException('Invalid file cursor.');
    const task = await this.readyTask(id);
    const status = await this.git.getStatusSummary(task.path);
    const rows = await this.db.select().from(schema.sessions).where(and(eq(schema.sessions.workspaceId, id), ne(schema.sessions.status, 'archived'))).limit(100);
    return { taskId: id, ...await previewCommit(task.path, status, selection, String(input.query ?? ''), Number(input.cursor ?? 0), this.previewReader), runningCount: (await this.tasks.finishPreview(id)).agents, running: rows.filter(row => this.activity?.status(row) === 'running').slice(0, 20).map(row => row.name) };
  }
  async action(id: number, input: WorkspaceGitInput) {
    workspaceBody(input);
    if (
      !['commit', 'push', 'sync', 'rename-branch'].includes(String(input.type))
    )
      throw new BadRequestException('Unsupported git action.');
    if (
      input.type === 'commit' &&
      (typeof input.message !== 'string' ||
        input.message.length > 4000)
    )
      throw new BadRequestException('A commit message must be a string of at most 4000 characters.');
    const selection = input.selection === undefined ? undefined : commitSelection(input.selection);
    if (input.push !== undefined && typeof input.push !== 'boolean') throw new BadRequestException('Invalid push option.');
    if (selection && (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision))) throw new BadRequestException('A commit preview is required.');
    if (
      input.type === 'rename-branch' &&
      (typeof input.branchName !== 'string' ||
        !input.branchName.trim() ||
        input.branchName.length > 240)
    )
      throw new BadRequestException('A branch name is required.');
    const task = await this.readyTask(id),
      repo = await this.tasks.repo(task.repoId);
    const key = await this.taskGit.repositoryKey(repo.path);
    return this.taskGit.exclusive(key, async () => {
      const current = await this.readyTask(id);
      await this.projects.assertProjectIsActive(repo.projectId);
      if (current.archivedAt || current.path !== task.path)
        throw new ConflictException('Task worktree changed.');
      const checkout = worktreeSimpleGit(current.path);
      const branch = (
        await checkout.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])
      ).trim();
      if (!branch || branch !== current.taskBranch)
        throw new ConflictException(
          'Task branch changed. Refresh before continuing.',
        );
      if (input.type === 'commit') {
        try {
          if (selection) {
            const status = await this.git.getStatusSummary(current.path);
            if (await commitRevision(current.path, status) !== input.revision) throw new ConflictException('The changes have moved on. Review the files before committing.');
            await commitSnapshot(current.path, this.git, status, selection, input.message as string, phase => this.phases.set(id, phase));
          } else await this.git.commit(current.path, { message: input.message as string, includeUnstaged: true });
          if (input.push) {
            this.phases.set(id, 'pushing');
            const result = await this.git.push(current.path);
            if (!result.pushed) throw new ConflictException('The commit was saved, but push was rejected. Refresh status before pushing again.');
          }
        } finally { this.phases.delete(id); }
      }
      if (input.type === 'push') {
        const result = await this.git.push(current.path);
        if (!result.pushed)
          throw new ConflictException(
            'Push was rejected. Fetch and review the remote branch before trying again.',
          );
      }
      if (input.type === 'sync') {
        const upstream = (
          await checkout.raw([
            'rev-parse',
            '--abbrev-ref',
            '--symbolic-full-name',
            '@{u}',
          ])
        ).trim();
        await this.taskGit.refresh(current.path, upstream);
        // Explicit fast-forward only: sync never rewrites work or resolves conflicts implicitly.
        await checkout.raw(['merge', '--ff-only', '--', upstream]);
      }
      if (input.type === 'rename-branch') {
        const name = (input.branchName as string).trim();
        await this.taskGit.validateBranch(repo.path, name);
        const held = await this.db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.repoId, repo.id),
              eq(schema.workspaces.taskBranch, name),
              isNull(schema.workspaces.archivedAt),
            ),
          );
        if (held.some((task) => task.id !== id))
          throw new ConflictException('Another task owns this branch.');
        await checkout.raw(['branch', '-m', '--', branch, name]);
        const timestamp = new Date().toISOString();
        // Keep task and session navigation identities in one short durable transaction.
        this.db.transaction((tx) => {
          tx.update(schema.workspaces)
            .set({
              taskBranch: name,
              desiredBranch: name,
              updatedAt: timestamp,
            })
            .where(eq(schema.workspaces.id, id))
            .run();
          tx.update(schema.sessions)
            .set({ branchName: name, updatedAt: timestamp })
            .where(eq(schema.sessions.workspaceId, id))
            .run();
        });
      }
      return this.summary(id);
    });
  }
}
