import {
  prepareProjectRepositories,
  type ProjectRepositorySetup,
} from './desktop-project-repositories.js';
import { moveSession, sessionChildCount } from '../sessions/session-hierarchy.js';
import { sidebarPriorityPage, type SidebarSessionRow } from './sidebar-priority-page.js';
import { desktopTaskSetupIssue } from './desktop-task-setup.js';
import { DesktopWorkspaceActivityService } from './desktop-workspace-activity.service.js';
import { DesktopSessionDelegates } from './desktop-session-delegates.js';
import { sessionAgentReference } from '../sessions/session-agent-message.js';
import { inactiveSessionStatus } from './desktop-session-status.js';
import { sessionAgentProvider } from '../sessions/session-provider.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  and,
  or,
  asc,
  desc,
  lt,
  eq,
  gt,
  isNull,
  isNotNull,
  ne,
  inArray,
  count,
  sql,
} from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { TaskGitService } from '../tasks/task-git.service.js';
import {
  isWorkspaceProjectImage,
  WORKSPACE_BRANCH_NAME_LIMIT,
  WORKSPACE_BRANCH_REF_LIMIT,
  WORKSPACE_ARCHIVE_AGENT_LIMIT,
  type WorkspaceAppearance,
  type WorkspaceSessionPage,
} from '@elevenex/shared';
import { taskBranchWindow, type TaskBranchChoice } from './desktop-task-branches.js';
import { refreshWorkspaceCheckout } from '../workspaces/workspace-ownership.js';
import {
  workspaceTaskError,
  MISSING_WORKTREE_ERROR,
} from '../workspaces/workspace-checkout-errors.js';
import { mapWorktrees } from '../worktrees/worktree-observation.js';

type Appearance = { -readonly [Key in keyof WorkspaceAppearance]: WorkspaceAppearance[Key] };
type Stage = 'planned' | 'active' | 'waiting';
export interface PageQuery {
  limit?: string;
  cursor?: string;
}
export function workspaceBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('A request object is required.');
  return value as Record<string, unknown>;
}
export function resourceId(value: unknown): number {
  const id =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new BadRequestException('Invalid resource id.');
  return id;
}
function bounds(query: PageQuery) {
  const limit = query.limit === undefined ? 50 : resourceId(query.limit);
  if (limit > 100) throw new BadRequestException('Page limit exceeds 100.');
  return {
    limit,
    cursor: query.cursor === undefined ? 0 : resourceId(query.cursor),
  };
}
function page<T extends { id: number }>(rows: T[], limit: number) {
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null,
  };
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException('Invalid text.');
  return value.trim();
}
function appearance(input: unknown): Appearance {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Invalid project appearance.');
  const result: Appearance = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'image') {
      if (value !== null && !isWorkspaceProjectImage(value))
        throw new BadRequestException('Invalid project image.');
      result.image = value;
      continue;
    }
    if (
      typeof value !== 'string' ||
      value.length > 64 ||
      !['look', 'hue', 'emoji', 'icon'].includes(key)
    )
      throw new BadRequestException('Invalid project appearance.');
    if (key === 'look') {
      if (!['letters', 'emoji', 'icon'].includes(value))
        throw new BadRequestException('Invalid project look.');
      result.look = value as Appearance['look'];
    }
    if (key === 'hue') {
      if (!['ocean', 'pine', 'plum', 'rust', 'steel', 'rose'].includes(value))
        throw new BadRequestException('Invalid project hue.');
      result.hue = value as Appearance['hue'];
    }
    if (key === 'emoji') result.emoji = value;
    if (key === 'icon') result.icon = value;
  }
  return result;
}

@Injectable()
export class DesktopWorkspaceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projects: ProjectsService,
    private readonly repos: ReposService,
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly branches: BranchesService,
    private readonly taskGit: TaskGitService,
    @Optional() private readonly activity?: DesktopWorkspaceActivityService,
    @Optional() private readonly delegates?: DesktopSessionDelegates,
  ) {}

  private async metadata(
    kind: 'project' | 'task',
    id: number,
  ): Promise<Record<string, unknown>> {
    const row = (
      await this.db
        .select()
        .from(schema.desktopWorkspaceMetadata)
        .where(
          and(
            eq(schema.desktopWorkspaceMetadata.kind, kind),
            eq(schema.desktopWorkspaceMetadata.resourceId, id),
          ),
        )
    )[0];
    if (!row) return {};
    try {
      const value: unknown = JSON.parse(row.value);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  private async saveMetadata(
    kind: 'project' | 'task',
    id: number,
    value: Record<string, unknown>,
  ) {
    await this.db
      .insert(schema.desktopWorkspaceMetadata)
      .values({ kind, resourceId: id, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: [
          schema.desktopWorkspaceMetadata.kind,
          schema.desktopWorkspaceMetadata.resourceId,
        ],
        set: { value: JSON.stringify(value) },
      });
  }
  private async saveProjectAppearance(id: number, { image, ...appearance }: Appearance) {
    const table = schema.desktopWorkspaceMetadata;
    const imagePatch = image === undefined ? {} : { projectImage: image };
    // Replace the legacy appearance independently so an older client can edit
    // it without racing or discarding an image written by a newer client.
    await this.db.insert(table)
      .values({ kind: 'project', resourceId: id, value: JSON.stringify({ appearance, ...(image ? imagePatch : {}) }) })
      .onConflictDoUpdate({
        target: [table.kind, table.resourceId],
        set: {
          value: sql`json_patch(json_set(${table.value}, '$.appearance', json(${JSON.stringify(appearance)})), ${JSON.stringify(imagePatch)})`,
        },
      });
  }
  private async projectView(row: typeof schema.projects.$inferSelect, includeImage = true) {
    const meta = await this.metadata('project', row.id);
    const image = includeImage && isWorkspaceProjectImage(meta.projectImage) ? meta.projectImage : undefined;
    return {
      id: row.id,
      name: row.name,
      agentInstructions: row.agentInstructions,
      ...(meta.appearance || image ? { appearance: { ...meta.appearance as WorkspaceAppearance, ...(image ? { image } : {}) } } : {}),
    };
  }
  private async taskView(
    row: typeof schema.workspaces.$inferSelect,
    projectId: number,
  ) {
    // Only stat the visible page's directories. Git/history scans stay on demand.
    row = (await refreshWorkspaceCheckout(this.db, row)).workspace ?? row;
    const needsWorkspace =
      !row.archivedAt &&
      row.taskState === 'ready' &&
      row.linkStatus === 'unlinked';
    const meta = await this.metadata('task', row.id);
    const stage = ['planned', 'active', 'waiting'].includes(String(meta.stage))
      ? (meta.stage as Stage)
      : 'active';
    return {
      id: row.id,
      projectId,
      repoId: row.repoId,
      name: row.name,
      branchName: row.taskBranch ?? row.createdFromRef ?? '',
      state: row.archivedAt
        ? 'finished'
        : needsWorkspace
          ? 'failed'
          : row.taskState,
      ...(row.taskTemporary && !row.archivedAt ? { temporary: true as const } : {}),
      stage,
      archivedAt: row.archivedAt,
      updatedAt: row.updatedAt,
      ...((row.taskState === 'failed' || needsWorkspace) && !row.archivedAt
        ? {
            setupIssue: desktopTaskSetupIssue(
              needsWorkspace ? MISSING_WORKTREE_ERROR : row.taskError,
            ),
          }
        : {}),
    };
  }
  private sessionView(
    row: typeof schema.sessions.$inferSelect,
    taskId: number,
  ) {
    const { status, turnStatus, commandCount } = this.activity?.view(row) ?? {
      status: inactiveSessionStatus(row),
    };
    return {
      id: row.id,
      taskId,
      canDelete: row.status === 'created' && inactiveSessionStatus(row) === 'queued' && status === 'queued',
      repoId: row.repoId,
      name: row.name ?? 'Session',
      status,
      // Additive: older desktops keep the legacy status above.
      ...(commandCount ? { turnStatus, commandCount } : {}),
      provider: sessionAgentProvider(row),
      ...(row.delegatedBySessionId ? { agentSelection: sessionAgentReference(row).selection } : {}),
      updatedAt: row.updatedAt,
      parentSessionId: row.parentSessionId,
    };
  }
  async listProjects(query: PageQuery & { images?: string }) {
    const { limit, cursor } = bounds(query);
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.hidden, false),
          isNull(schema.projects.archivedAt),
          gt(schema.projects.id, cursor),
        ),
      )
      .orderBy(asc(schema.projects.id))
      .limit(limit + 1);
    return page(
      await Promise.all(
        rows.map(async (row) => ({
          ...(await this.projectView(row, query.images === 'true')),
          agentInstructions: null,
        })),
      ),
      limit,
    );
  }
  async project(id: number) {
    const project = await this.projects.findOne(id);
    const rows = await this.db
      .select({
        id: schema.repos.id,
        projectId: schema.repos.projectId,
        name: schema.repos.name,
        path: schema.repos.path,
        defaultBase: schema.repos.taskBaseRef,
      })
      .from(schema.repos)
      .where(eq(schema.repos.projectId, id))
      .orderBy(asc(schema.repos.id))
      .limit(101);
    return {
      project: await this.projectView(project),
      repositories: page(rows, 100),
    };
  }
  async listTasks(query: PageQuery & { projectId?: string; state?: string }) {
    const { limit, cursor } = bounds(query);
    if (
      query.state !== undefined &&
      !['active', 'finished'].includes(query.state)
    )
      throw new BadRequestException('Invalid task state.');
    const rows = await this.db
      .select({
        task: schema.workspaces,
        projectId: schema.repos.projectId,
        projectName: schema.projects.name,
        repoName: schema.repos.name,
        // The project/path index keeps this count local to the bounded task page.
        projectRepositoryCount:
          sql<number>`(select count(*) from ${schema.repos} as project_repos where project_repos.project_id = ${schema.repos.projectId})`.mapWith(
            Number,
          ),
      })
      .from(schema.workspaces)
      .innerJoin(schema.repos, eq(schema.repos.id, schema.workspaces.repoId))
      .innerJoin(
        schema.projects,
        eq(schema.projects.id, schema.repos.projectId),
      )
      .where(
        and(
          eq(schema.workspaces.isDefault, false),
          eq(schema.projects.hidden, false),
          isNull(schema.projects.archivedAt),
          query.projectId
            ? eq(schema.repos.projectId, resourceId(query.projectId))
            : undefined,
          query.state === 'finished'
            ? isNotNull(schema.workspaces.archivedAt)
            : isNull(schema.workspaces.archivedAt),
          cursor ? lt(schema.workspaces.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(schema.workspaces.id))
      .limit(limit + 1);
    return page(
      await mapWorktrees(
        rows,
        async (row) => ({
          ...(await this.taskView(row.task, row.projectId)),
          projectName: row.projectName,
          repoName: row.repoName,
          projectRepositoryCount: row.projectRepositoryCount,
        }),
      ),
      limit,
    );
  }
  async taskRequest(repoId: number, value: unknown) {
    const requestId = text(value, 100);
    // task_request_id already has a unique index. Checking delivery never enumerates tasks.
    const [row] = await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces)
      .where(and(eq(schema.workspaces.taskRequestId, requestId), eq(schema.workspaces.repoId, repoId))).limit(1);
    return { task: row ? await this.task(row.id) : null };
  }
  async task(id: number) {
    const task = await this.tasks.record(id);
    const repo = await this.tasks.repo(task.repoId);
    const [repositories] = await this.db
      .select({ count: count() })
      .from(schema.repos)
      .where(eq(schema.repos.projectId, repo.projectId));
    return {
      ...(await this.taskView(task, repo.projectId)),
      projectName: (await this.projects.findOne(repo.projectId)).name,
      repoName: repo.name,
      projectRepositoryCount: repositories.count,
    };
  }
  async listSessions(taskId: number, query: PageQuery & { order?: string; state?: string; parentSessionId?: string; childOrder?: string }): Promise<WorkspaceSessionPage> {
    if (query.order !== undefined && query.order !== 'latest') throw new BadRequestException('Invalid session order.');
    if (query.state === 'priority') {
      if (query.parentSessionId !== undefined || query.childOrder !== undefined)
        throw new BadRequestException('Priority pages include all session levels.');
      const { limit, cursor } = bounds(query);
      const task = await this.tasks.record(taskId);
      if (task.archivedAt) return { items: [], parentSessions: [], nextCursor: null };
      return sidebarPriorityPage(
        this.db, taskId, limit, cursor || null,
        this.activity?.priorityCandidateIds() ?? [],
        (rows) => this.sidebarSessionViews(rows, taskId),
      );
    }
    if (query.state !== undefined && query.state !== 'normal' && query.state !== 'archived') throw new BadRequestException('Invalid session state.');
    const parentId = query.parentSessionId === undefined ? undefined : query.parentSessionId === 'root' ? null : resourceId(query.parentSessionId);
    if (query.childOrder !== undefined && (query.childOrder !== 'nested' || typeof parentId !== 'number')) throw new BadRequestException('Invalid child order.');
    const nested = query.childOrder === 'nested';
    let position: { rank: number; id: number } | undefined;
    if (nested && query.cursor !== undefined) {
      if (query.cursor.length > 40 || !/^(0|[1-9]\d*):[1-9]\d*$/.test(query.cursor)) throw new BadRequestException('Invalid nesting cursor.');
      const [rank, id] = query.cursor.split(':').map(Number);
      if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(id)) throw new BadRequestException('Invalid nesting cursor.');
      position = { rank, id };
    }
    const latest = query.order === 'latest';
    const task = await this.tasks.record(taskId);
    const { limit, cursor } = bounds(nested ? { limit: query.limit } : query);
    const rows = await this.db
      .select({ session: schema.sessions, childCount: sessionChildCount })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, taskId),
          eq(schema.sessions.surface, 'session'),
          parentId === undefined ? undefined : eq(schema.sessions.isTemporary, false),
          parentId === undefined ? undefined : parentId === null
            ? sql`(${schema.sessions.parentSessionId} is null or not exists (select 1 from sessions parent where parent.id = ${schema.sessions.parentSessionId} and parent.status != 'archived'))`
            : eq(schema.sessions.parentSessionId, parentId),
          query.state === 'archived' ? eq(schema.sessions.status, 'archived')
            : query.state === 'normal' || !task.archivedAt ? ne(schema.sessions.status, 'archived') : undefined,
          nested ? position ? or(
            latest ? lt(schema.sessions.nestingOrder, position.rank) : gt(schema.sessions.nestingOrder, position.rank),
            and(eq(schema.sessions.nestingOrder, position.rank), latest ? lt(schema.sessions.id, position.id) : gt(schema.sessions.id, position.id)),
          ) : undefined : latest ? lt(schema.sessions.id, query.cursor === undefined ? Number.MAX_SAFE_INTEGER : cursor) : gt(schema.sessions.id, cursor),
        ),
      )
      .orderBy(...(nested ? [latest ? desc(schema.sessions.nestingOrder) : asc(schema.sessions.nestingOrder)] : []), latest ? desc(schema.sessions.id) : asc(schema.sessions.id))
      .limit(limit + 1);
    const result = page(this.sidebarSessionViews(rows, taskId, !!task.archivedAt), limit);
    if (nested && rows.length > limit) result.nextCursor = `${rows[limit - 1].session.nestingOrder}:${rows[limit - 1].session.id}`;
    return latest ? { ...result, items: result.items.reverse() } : result;
  }
  private sidebarSessionViews(rows: readonly SidebarSessionRow[], taskId: number, archived = false) {
    const parentRefs = this.delegates?.parentReferences(rows.map(row => row.session), taskId);
    const summaries = archived ? undefined : this.delegates?.childSummaries(taskId,
      rows.filter(row => row.childCount > 0).map(row => row.session.id));
    return rows.map(({ session, childCount }) => {
      const delegatedBy = parentRefs?.get(session.id);
      return { ...this.sessionView(session, taskId), childCount,
        ...(delegatedBy ? { delegatedBy, ...this.delegates?.sidebarDetail(session, delegatedBy) } : {}),
        ...summaries?.get(session.id) };
    });
  }
  async projectNameAvailability(value: unknown) {
    const name = text(value, 100);
    // Match the database's unique name constraint, including archived/hidden rows.
    return { available: (await this.projects.findByName(name)) === null };
  }
  async createProject(
    input: {
      name?: unknown;
      path?: unknown;
      additionalPaths?: unknown;
      appearance?: unknown;
      repositorySetup?: unknown;
    },
    signal: AbortSignal = AbortSignal.timeout(120_000),
  ) {
    workspaceBody(input);
    const name = text(input.name, 100);
    if (!(await this.projectNameAvailability(name)).available)
      throw new ConflictException('Project name already exists');
    const additional = input.additionalPaths ?? [];
    if (!Array.isArray(additional) || additional.length > 19)
      throw new BadRequestException('At most 20 repositories are allowed.');
    const paths = [
      text(input.path, 4096),
      ...additional.map((value: unknown) => text(value, 4096)),
    ];
    if (new Set(paths).size !== paths.length)
      throw new BadRequestException('Duplicate repository paths.');
    const look =
      input.appearance === undefined ? undefined : appearance(input.appearance);
    let preparedPaths = paths;
    if (input.repositorySetup !== undefined) {
      if (
        !Array.isArray(input.repositorySetup) ||
        input.repositorySetup.length !== paths.length
      )
        throw new BadRequestException('Invalid repository setup.');
      const setup: ProjectRepositorySetup[] = input.repositorySetup.map(
        (value, index) => {
          const entry = workspaceBody(value);
          const path = text(entry.path, 4096);
          if (
            path !== paths[index] ||
            (entry.initialize !== undefined &&
              typeof entry.initialize !== 'boolean') ||
            (entry.clone !== undefined && entry.initialize)
          )
            throw new BadRequestException('Invalid repository setup.');
          return {
            path,
            ...(entry.clone === undefined
              ? {}
              : { clone: text(entry.clone, 4096) }),
            ...(entry.initialize === undefined
              ? {}
              : { initialize: entry.initialize }),
          };
        },
      );
      preparedPaths = [...(await prepareProjectRepositories(setup, signal))];
    }
    const repositories = await Promise.all(
      preparedPaths.map((path) => this.repos.validatePath(path)),
    );
    if (
      new Set(repositories.map((repository) => repository.path)).size !==
      repositories.length
    )
      throw new BadRequestException('Duplicate repository paths.');
    signal.throwIfAborted();
    const project = await this.projects.create(name, false, repositories);
    if (look)
      await this.saveProjectAppearance(project.id, look);
    return this.project(project.id);
  }
  async retryTask(id: number, input: unknown = {}) {
    const body = workspaceBody(input);
    if (Object.keys(body).some((key) => key !== 'recovery'))
      throw new BadRequestException('Invalid task recovery.');
    const recovery = body.recovery;
    if (recovery === undefined) await this.tasks.retry(id);
    else {
      if (
        recovery !== 'use-existing' &&
        recovery !== 'snapshot' &&
        recovery !== 'exceed-worktree-limit' &&
        recovery !== 'restore-branch' &&
        recovery !== 'new-workspace'
      )
        throw new BadRequestException('Invalid task recovery.');
      const task = await this.tasks.record(id);
      if (task.archivedAt || task.taskState !== 'failed')
        throw new BadRequestException(
          'Refresh this task before choosing a setup recovery.',
        );
      const issue = desktopTaskSetupIssue(task.taskError);
      if (recovery === 'use-existing' && issue?.code === 'external-checkout')
        await this.tasks.retry(id, { confirmExternal: true }, task.taskError);
      else if (recovery === 'snapshot' && issue?.canUseSnapshot)
        await this.tasks.retry(
          id,
          {
            checkoutMode: 'snapshot',
            environment: 'automatic',
          },
          task.taskError,
        );
      else if (
        recovery === 'exceed-worktree-limit' &&
        issue?.canExceedWorktreeLimit
      )
        await this.tasks.retry(id, { confirmOverLimit: true }, task.taskError);
      else if (
        recovery === 'new-workspace' &&
        issue?.workspaceRecovery === 'new-workspace'
      )
        await this.tasks.retry(id, { environment: 'new' }, task.taskError);
      else if (
        recovery === 'restore-branch' &&
        issue?.workspaceRecovery === 'restore-branch'
      ) {
        const error = workspaceTaskError(task.taskError);
        await this.tasks.retry(
          id,
          {
            mode: 'new',
            baseRef: String(error?.savedCommit),
            branchName: task.taskBranch ?? '',
          },
          task.taskError,
        );
      } else
        throw new BadRequestException(
          'This recovery is not available for the task. Refresh its setup state.',
        );
    }
    return this.task(id);
  }
  async addRepository(projectId: number, path: unknown) {
    await this.repos.addRepo(projectId, text(path, 4096));
    return this.project(projectId);
  }
  async updateProject(
    id: number,
    input: {
      name?: unknown;
      agentInstructions?: unknown;
      appearance?: unknown;
    },
  ) {
    workspaceBody(input);
    await this.projects.assertProjectIsActive(id);
    const patch: {
      name?: string;
      agentInstructions?: string;
      updatedAt: string;
    } = { updatedAt: new Date().toISOString() };
    if (input.name !== undefined) patch.name = text(input.name, 100);
    if (input.agentInstructions !== undefined) {
      if (
        typeof input.agentInstructions !== 'string' ||
        input.agentInstructions.length > 100000
      )
        throw new BadRequestException('Invalid instructions.');
      patch.agentInstructions = input.agentInstructions;
    }
    const look =
      input.appearance === undefined ? undefined : appearance(input.appearance);
    await this.db
      .update(schema.projects)
      .set(patch)
      .where(eq(schema.projects.id, id));
    if (look)
      await this.saveProjectAppearance(id, look);
    return this.project(id);
  }
  async createTask(input: {
    repoId?: unknown;
    name?: unknown;
    requestId?: unknown;
    branchName?: unknown;
    baseRef?: unknown;
    mode?: unknown;
  }) {
    workspaceBody(input);
    const repoId = resourceId(input.repoId),
      name = text(input.name, 160),
      requestId = text(input.requestId, 100);
    const repo = await this.tasks.repo(repoId);
    const defaults =
      input.branchName === undefined
        ? await this.tasks.defaults(repoId, name)
        : undefined;
    const mode = input.mode ?? 'new';
    if (mode !== 'new' && mode !== 'existing')
      throw new BadRequestException('Invalid branch mode.');
    const branchName =
      input.branchName === undefined
        ? defaults!.branchName
        : text(
            input.branchName,
            mode === 'existing'
              ? WORKSPACE_BRANCH_REF_LIMIT
              : WORKSPACE_BRANCH_NAME_LIMIT,
          );
    const task = await this.tasks.create(repoId, {
      name,
      requestId,
      branchName,
      mode,
      baseRef:
        input.baseRef === undefined
          ? (repo.taskBaseRef ?? defaults?.baseRef ?? undefined)
          : text(input.baseRef, WORKSPACE_BRANCH_REF_LIMIT),
    });
    return this.task(task.id);
  }
  private async activeTaskSession(taskId: number, sessionId: number) {
    const task = await this.tasks.record(taskId);
    const repo = await this.tasks.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    if (task.archivedAt || task.taskState !== 'ready')
      throw new BadRequestException('Task is not ready for session changes.');
    const [session] = await this.db.select().from(schema.sessions).where(and(
      eq(schema.sessions.id, sessionId), eq(schema.sessions.workspaceId, taskId), eq(schema.sessions.surface, 'session'),
    )).limit(1);
    if (!session) throw new BadRequestException('Session does not belong to this task.');
    return session;
  }
  async moveSession(taskId: number, sessionId: number, parentSessionId: unknown) {
    await this.activeTaskSession(taskId, sessionId);
    const moved = moveSession(this.db, taskId, sessionId, parentSessionId === null ? null : resourceId(parentSessionId));
    const delegatedBy = this.delegates?.parentReferences([moved], taskId).get(moved.id);
    return { ...this.sessionView(moved, taskId), ...(delegatedBy ? { delegatedBy } : {}) };
  }
  async deleteSession(taskId: number, sessionId: number) {
    await this.activeTaskSession(taskId, sessionId);
    await this.sessions.deleteUnstarted(sessionId, session =>
      session.workspaceId === taskId && session.surface === 'session' && this.sessionView(session, taskId).canDelete,
    );
    return { accepted: true as const };
  }
  async archiveSession(taskId: number, sessionId: number, confirmStop: unknown, stopAgents?: unknown, includeChildren?: unknown) {
    if (typeof confirmStop !== 'boolean') throw new BadRequestException('A stop confirmation is required.');
    if (includeChildren !== undefined && typeof includeChildren !== 'boolean')
      throw new BadRequestException('Invalid subsession archive option.');
    const session = await this.activeTaskSession(taskId, sessionId);
    if (this.sessionView(session, taskId).status === 'running' && !confirmStop)
      throw new BadRequestException('This session is running. Stop and archive to confirm.');
    let approved: readonly number[] | undefined;
    if (stopAgents !== undefined) {
      if (!Array.isArray(stopAgents) || !stopAgents.length || stopAgents.length > WORKSPACE_ARCHIVE_AGENT_LIMIT ||
          new Set(stopAgents).size !== stopAgents.length || stopAgents.some(id => !Number.isSafeInteger(id) || id <= 0 || id === sessionId))
        throw new BadRequestException('Invalid agent stop confirmation.');
      approved = stopAgents;
      if (!includeChildren && !await this.delegates?.stopChildren(taskId, sessionId, approved))
        throw new ConflictException('The running agents changed. Review them before archiving.');
    }
    if (includeChildren) {
      await this.sessions.archiveTaskSessionGroup(taskId, sessionId, rows => {
        if (approved && !this.delegates?.confirmedChildren(taskId, sessionId, approved))
          throw new ConflictException('The running agents changed. Review them before archiving.');
        if (!confirmStop && rows.some(row => {
          const { status, commandCount } = this.sessionView(row, taskId);
          return status === 'running' || !!commandCount || (row.id !== sessionId && status === 'attention');
        })) throw new BadRequestException('A conversation in this group is running or needs attention. Stop and archive to confirm.');
      });
      return { accepted: true as const };
    }
    await this.sessions.archiveAndStop(sessionId, true);
    // Older desktops expect children to return to task level after a single-session archive.
    await this.db.update(schema.sessions).set({ parentSessionId: null }).where(eq(schema.sessions.parentSessionId, sessionId));
    // Desktop row archives return on task reopen, just like archives made at close.
    // This does not change the legacy standalone session-archive semantics.
    await this.db.update(schema.sessions).set({ archivedByTask: true }).where(eq(schema.sessions.id, sessionId));
    return { accepted: true as const };
  }
  async restoreSession(taskId: number, sessionId: number) {
    const session = await this.activeTaskSession(taskId, sessionId);
    const restored = session.status === 'archived' ? await this.sessions.unarchive(sessionId) : session;
    await this.db.update(schema.sessions).set({ archivedByTask: false }).where(eq(schema.sessions.id, sessionId));
    return this.sessionView(restored, taskId);
  }
  async createSession(input: { taskId?: unknown; name?: unknown }) {
    workspaceBody(input);
    const task = await this.tasks.record(resourceId(input.taskId));
    const repo = await this.tasks.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    if (task.archivedAt || task.taskState !== 'ready')
      throw new BadRequestException('Task is not ready for a session.');
    const session = await this.sessions.create({
      repoId: task.repoId,
      workspaceId: task.id,
      name: input.name === undefined ? undefined : text(input.name, 160),
    });
    return this.sessionView(session, task.id);
  }
  async renameTask(id: number, input: unknown) {
    const body = workspaceBody(input);
    const task = await this.tasks.record(id);
    if (task.archivedAt)
      throw new BadRequestException('Closed tasks are read-only.');
    await this.tasks.rename(id, text(body.name, 160));
    return this.task(id);
  }
  async setStage(id: number, stage: unknown) {
    if (stage !== 'planned' && stage !== 'active' && stage !== 'waiting')
      throw new BadRequestException('Invalid task stage.');
    const task = await this.tasks.record(id);
    if (task.archivedAt)
      throw new BadRequestException('Closed tasks are read-only.');
    const repo = await this.tasks.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    await this.saveMetadata('task', id, {
      ...(await this.metadata('task', id)),
      stage,
    });
    return this.task(id);
  }
  async listBranches(
    repoId: number,
    query: string,
    limit: number,
    includeRemote = false,
  ) {
    const queryLimit = includeRemote
      ? WORKSPACE_BRANCH_REF_LIMIT
      : WORKSPACE_BRANCH_NAME_LIMIT;
    if (
      typeof query !== 'string' ||
      query.length > queryLimit ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid branch query.');
    const repo = await this.tasks.repo(repoId);
    if (includeRemote) {
      const [branches, { baseRef, remotes }] = await Promise.all([
        this.branches.getBranches(repo.path, true),
        this.taskGit.branchDefaults(repo.path),
      ]);
      const { choices, defaultBase } = taskBranchWindow(
        branches,
        remotes,
        repo.taskBaseRef ?? baseRef,
        query,
        limit,
      );
      return this.branchViews(repoId, choices, defaultBase);
    }

    const [rows, defaults] = await Promise.all([
      this.branches.searchBranches(repo.path, query, true),
      this.tasks.defaults(repoId),
    ]);
    const defaultBase = repo.taskBaseRef ?? defaults.baseRef;
    const defaultName =
      defaultBase?.replace(/^refs\/(heads|remotes)\//, '') ?? null;
    const selected = rows.slice(0, limit);
    // Keep the actual default available in the initial choice window, even in a repository with hundreds of branches.
    if (
      !query &&
      defaultName &&
      !selected.some((branch) => branch.name === defaultName)
    )
      selected.splice(Math.max(0, limit - 1), 1, {
        name: defaultName,
        commit: '',
        label: defaultName,
        current: false,
        isRemote: defaultBase!.startsWith('refs/remotes/'),
        hasWorktree: false,
        worktreePath: null,
      });
    return this.branchViews(
      repoId,
      selected.map((branch) => ({
        name: branch.name,
        current: branch.current,
        isDefault: branch.name === defaultName,
      })),
      defaultBase,
    );
  }

  private async branchViews(
    repoId: number,
    selected: readonly TaskBranchChoice[],
    defaultBase: string | null,
  ) {
    const names = [
      ...new Set(selected.map((branch) => branch.remoteBranch ?? branch.name)),
    ];
    const held = names.length
      ? await this.db
          .select({
            branch: schema.workspaces.taskBranch,
            name: schema.workspaces.name,
          })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.repoId, repoId),
              eq(schema.workspaces.isDefault, false),
              isNull(schema.workspaces.archivedAt),
              inArray(schema.workspaces.taskBranch, names),
            ),
          )
      : [];
    return selected.map((branch) => ({
      ...branch,
      defaultBase,
      heldTaskName:
        held.find((task) => task.branch === (branch.remoteBranch ?? branch.name))
          ?.name ?? null,
    }));
  }
}
