import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createTestDb } from '../database/testing/create-test-db.js';
import * as schema from '../database/schema/index.js';
import { moveSession } from './session-hierarchy.js';

describe('session hierarchy', () => {
  let database: ReturnType<typeof createTestDb>;
  let repoId: number, taskId: number;
  beforeEach(() => {
    database = createTestDb();
    const project = database.db.insert(schema.projects).values({ name: 'Project' }).returning().get();
    repoId = database.db.insert(schema.repos).values({ projectId: project.id, name: 'Repo', path: '/repo' }).returning().get().id;
    taskId = database.db.insert(schema.workspaces).values({ repoId, name: 'Task', path: '/repo/task', taskState: 'ready' }).returning().get().id;
  });
  afterEach(() => database.sqlite.close());
  const session = (patch: Partial<typeof schema.sessions.$inferInsert> = {}) => database.db.insert(schema.sessions).values({ repoId, workspaceId: taskId, branchName: 'main', worktreePath: '/repo/task', ...patch }).returning().get();
  it('nests, reparents and returns to task level without changing transcript provenance or status', () => {
    const a = session(), b = session(), c = session();
    expect(moveSession(database.db, taskId, b.id, a.id)).toMatchObject({ parentSessionId: a.id, status: 'created', worktreePath: b.worktreePath });
    expect(moveSession(database.db, taskId, b.id, c.id).parentSessionId).toBe(c.id);
    expect(moveSession(database.db, taskId, b.id, null).parentSessionId).toBeNull();
  });
  it('rejects self, cycles, grandchildren and moving a populated group under another session', () => {
    const a = session(), b = session(), c = session();
    moveSession(database.db, taskId, b.id, a.id);
    for (const [source, target] of [[a.id,a.id],[a.id,b.id],[c.id,b.id],[a.id,c.id]])
      expect(() => moveSession(database.db, taskId, source, target)).toThrow();
    expect(database.db.select().from(schema.sessions).where(eq(schema.sessions.id, b.id)).get()?.parentSessionId).toBe(a.id);
  });
  it('rejects foreign tasks, hidden/temporary/archived conversations and malformed IDs', () => {
    const root = session(), child = session();
    for (const invalid of [session({ workspaceId: null }), session({ isTemporary: true }), session({ surface: 'agent_query' }), session({ status: 'archived' })]) {
      expect(() => moveSession(database.db, taskId, child.id, invalid.id)).toThrow();
      expect(() => moveSession(database.db, taskId, invalid.id, root.id)).toThrow();
    }
    for (const invalid of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER + 1]) expect(() => moveSession(database.db, taskId, child.id, invalid)).toThrow();
    database.db.update(schema.workspaces).set({ taskState: 'finishing' }).where(eq(schema.workspaces.id, taskId)).run();
    expect(() => moveSession(database.db, taskId, child.id, root.id)).toThrow('not ready');
  });
  it('does not let archived children block a move or become grandchildren on restore', () => {
    const parent = session(), target = session(), archived = session({parentSessionId:parent.id,status:'archived'});
    moveSession(database.db,taskId,parent.id,target.id);
    expect(database.db.select().from(schema.sessions).where(eq(schema.sessions.id,archived.id)).get()?.parentSessionId).toBeNull();
  });
  it('deleting a parent retains every child conversation at task level', () => {
    const root = session(), child = session();
    moveSession(database.db, taskId, child.id, root.id);
    database.db.delete(schema.sessions).where(eq(schema.sessions.id, root.id)).run();
    expect(database.db.select().from(schema.sessions).where(eq(schema.sessions.id, child.id)).get()).toMatchObject({ parentSessionId: null });
  });
});

it('migrates old folders into groups without losing names, archived states or empty folders', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    const migrations = readMigrationFiles({migrationsFolder:resolve(process.cwd(),'drizzle')}).slice(0, 53);
    for (const migration of migrations.slice(0,-1)) for (const statement of migration.sql) sqlite.exec(statement);
    sqlite.exec(`
      INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'Project','now','now');
      INSERT INTO repos(id,project_id,name,path,created_at) VALUES(1,1,'Repo','/repo','now');
      INSERT INTO workspaces(id,repo_id,name,path,created_at,updated_at) VALUES(1,1,'Task','/repo/task','now','now');
      INSERT INTO session_folders(id,repo_id,workspace_id,name,created_at,updated_at) VALUES(1,1,1,'Mixed','now','now'),(2,1,1,'Empty','now','now');
      INSERT INTO sessions(id,repo_id,workspace_id,folder_id,branch_name,worktree_path,name,status,created_at,updated_at)
      VALUES(1,1,1,1,'main','/repo/task','Archived first','archived','now','now'),
            (2,1,1,1,'main','/repo/task','Active parent','stopped','now','now'),
            (3,1,1,1,'main','/repo/task','Active child','active','now','now');
    `);
    for (const statement of migrations.at(-1)!.sql) sqlite.exec(statement);
    expect(sqlite.prepare('SELECT id,name,status,parent_session_id FROM sessions ORDER BY id').all()).toEqual([
      {id:1,name:'Archived first',status:'archived',parent_session_id:2},
      {id:2,name:'Active parent',status:'stopped',parent_session_id:null},
      {id:3,name:'Active child',status:'active',parent_session_id:2},
    ]);
    expect(sqlite.prepare('SELECT count(*) AS total FROM session_folders').get()).toEqual({total:2});
  } finally { sqlite.close(); }
});
