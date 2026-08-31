import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { WorktreesService } from './worktrees.service.js';
import { WorktreePoolService } from './worktree-pool.service.js';
import { worktreeSimpleGit } from '../config/system-paths.js';

/**
 * End-to-end rename coverage against a real git repository on disk: the mocked
 * unit specs cannot catch `git worktree move` refusing to create missing parent
 * directories, nor rows in other tables left pointing at the old path.
 */
describe('WorktreePoolService.rename (real git)', () => {
  // Real git plus a real migrated database per test: generous, because these
  // run alongside the other suites' git work on the same machine.
  jest.setTimeout(120_000);

  let tmpRoot: string;
  let projectRoot: string;
  let repoPath: string;
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: InstanceType<typeof Database>;
  let service: WorktreePoolService;
  let repo: typeof schema.repos.$inferSelect;

  async function git(cwd: string, args: string[]) {
    return worktreeSimpleGit(cwd).raw(args);
  }

  beforeEach(async () => {
    tmpRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'elevenex-rename-')),
    );
    projectRoot = path.join(tmpRoot, 'project');
    repoPath = path.join(projectRoot, 'repo');
    await fs.mkdir(repoPath, { recursive: true });

    await git(repoPath, ['init', '-q', '--initial-branch=main', '.']);
    await git(repoPath, ['config', 'user.email', 'test@example.com']);
    await git(repoPath, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repoPath, 'README.md'), '# repo\n');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-qm', 'init']);

    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema });
    migrate(db, {
      migrationsFolder: path.resolve(__dirname, '..', '..', 'drizzle'),
    });

    const [project] = await db
      .insert(schema.projects)
      .values({ name: 'Proj' })
      .returning();
    [repo] = await db
      .insert(schema.repos)
      .values({ projectId: project.id, name: 'repo', path: repoPath })
      .returning();

    service = new WorktreePoolService(
      db,
      new WorktreesService(),
      {
        archiveAndStopByRepoAndWorktreePath: jest
          .fn()
          .mockResolvedValue(undefined),
      } as unknown as SessionsService,
      {
        assertProjectIsActive: jest.fn().mockResolvedValue(undefined),
      } as unknown as ProjectsService,
      {
        getStatus: jest.fn().mockReturnValue('idle'),
      } as unknown as ClaudeHooksService,
    );
  });

  afterEach(async () => {
    sqlite.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function addWorktree(worktreePath: string, branchName: string) {
    await git(repoPath, [
      'worktree',
      'add',
      '-q',
      worktreePath,
      '-b',
      branchName,
    ]);
    await service.reconcileRepo(repo);
    const rows = await db.select().from(schema.repoWorktrees);
    const real = await fs.realpath(worktreePath);
    const row = rows.find((candidate) => candidate.path === real);
    if (!row) {
      throw new Error(
        `No pool row for ${real}; have ${rows.map((r) => r.path).join(', ')}`,
      );
    }
    return row;
  }

  it('renames a worktree that already lives under .worktrees/<repo>', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');

    const renamed = await service.rename(repo, pool.id, 'fix-login-timeout');

    const expected = path.join(
      projectRoot,
      '.worktrees',
      'repo',
      'fix-login-timeout',
    );
    expect(renamed.path).toBe(expected);
    expect(renamed.name).toBe('fix-login-timeout');
    await expect(fs.stat(expected)).resolves.toBeTruthy();
    const list = await git(repoPath, ['worktree', 'list', '--porcelain']);
    expect(list).toContain(expected);
  });

  it('keeps the new name across later pool listings (reconcile must not clobber it)', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');

    await service.rename(repo, pool.id, 'fix-login-timeout');
    await service.reconcileRepo(repo);
    const items = await service.listForRepo(repo);

    const item = items.find((candidate) => candidate.id === pool.id)!;
    expect(item.name).toBe('fix-login-timeout');
    expect(item.currentBranch).toBe('feature');
  });

  it('renames a worktree that lives outside .worktrees (missing parent dir)', async () => {
    const source = path.join(projectRoot, 'repo-feature');
    const pool = await addWorktree(source, 'feature');

    const renamed = await service.rename(repo, pool.id, 'fix-login-timeout');

    const expected = path.join(
      projectRoot,
      '.worktrees',
      'repo',
      'fix-login-timeout',
    );
    expect(renamed.path).toBe(expected);
    await expect(fs.stat(expected)).resolves.toBeTruthy();
  });

  it('repoints sessions, terminals and actions attached to the old path', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'feature',
        path: pool.path,
        poolWorktreeId: pool.id,
      })
      .returning();
    const [session] = await db
      .insert(schema.sessions)
      .values({
        repoId: repo.id,
        workspaceId: workspace.id,
        branchName: 'feature',
        worktreePath: pool.path,
      })
      .returning();
    const [terminal] = await db
      .insert(schema.userTerminals)
      .values({ worktreePath: pool.path, name: 'shell', shell: '/bin/bash' })
      .returning();
    const [action] = await db
      .insert(schema.actions)
      .values({ worktreePath: pool.path, name: 'test', command: 'pnpm test' })
      .returning();
    await db.insert(schema.worktreeContexts).values({
      repoId: repo.id,
      worktreePath: pool.path,
      contextSentence: 'old context',
    });

    const renamed = await service.rename(repo, pool.id, 'fix-login-timeout');

    const [updatedWorkspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));
    expect(updatedWorkspace.path).toBe(renamed.path);

    const [updatedSession] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, session.id));
    expect(updatedSession.worktreePath).toBe(renamed.path);

    const [updatedTerminal] = await db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.id, terminal.id));
    expect(updatedTerminal.worktreePath).toBe(renamed.path);

    const [updatedAction] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, action.id));
    expect(updatedAction.worktreePath).toBe(renamed.path);

    const [updatedContext] = await db
      .select()
      .from(schema.worktreeContexts)
      .where(eq(schema.worktreeContexts.repoId, repo.id));
    expect(updatedContext.worktreePath).toBe(renamed.path);
  });

  it('renames the linked workspace so the sidebar label follows', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'old task',
        path: pool.path,
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();

    await service.rename(repo, pool.id, 'fix-login-timeout');

    const [updated] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));
    expect(updated.name).toBe('fix-login-timeout');
  });

  it('keeps the workspace name unique when another workspace already has it', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');
    await db.insert(schema.workspaces).values({
      repoId: repo.id,
      name: 'fix-login-timeout',
      path: path.join(projectRoot, 'somewhere-else'),
    });
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name: 'old task',
        path: pool.path,
        poolWorktreeId: pool.id,
        linkStatus: 'linked',
      })
      .returning();

    await service.rename(repo, pool.id, 'fix-login-timeout');

    const [updated] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));
    expect(updated.name).toBe('fix-login-timeout 2');
  });

  it('rejects renaming the main working tree with an actionable message', async () => {
    await service.reconcileRepo(repo);
    const rows = await db.select().from(schema.repoWorktrees);
    const pool = rows.find((row) => row.path === repoPath)!;

    await expect(
      service.rename(repo, pool.id, 'something-else'),
    ).rejects.toThrow(/main working tree/i);
    await expect(fs.stat(repoPath)).resolves.toBeTruthy();
  });

  it('rejects a name whose slug collides with an existing directory', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');
    await addWorktree(
      path.join(projectRoot, '.worktrees', 'repo', 'taken'),
      'taken',
    );

    await expect(service.rename(repo, pool.id, 'Taken')).rejects.toThrow(
      /already exists/i,
    );
    await expect(fs.stat(source)).resolves.toBeTruthy();
  });

  it('renames in place when the slug is unchanged', async () => {
    const source = path.join(projectRoot, '.worktrees', 'repo', 'feature');
    const pool = await addWorktree(source, 'feature');

    const renamed = await service.rename(repo, pool.id, 'Feature');

    expect(renamed.path).toBe(pool.path);
    expect(renamed.name).toBe('Feature');
  });

  it('keeps the worktree usable after rename', async () => {
    const source = path.join(projectRoot, 'repo-feature');
    const pool = await addWorktree(source, 'feature');

    const renamed = await service.rename(repo, pool.id, 'fix-login-timeout');

    await fs.writeFile(path.join(renamed.path, 'new.txt'), 'hello\n');
    await git(renamed.path, ['add', '.']);
    await git(renamed.path, ['commit', '-qm', 'after rename']);
    const log = await git(renamed.path, ['log', '--oneline', '-1']);
    expect(log).toContain('after rename');

    const items = await service.listForRepo(repo);
    const item = items.find((candidate) => candidate.id === pool.id)!;
    expect(item.isMissing).toBe(false);
    expect(item.currentBranch).toBe('feature');
  });
});
