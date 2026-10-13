import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { WorktreeContextService } from './worktree-context.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';
import * as schema from '../database/schema/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const branchContext = {
  rootRef: 'main',
  resolvedRootRef: 'main',
  usingRepoDefaultRootRef: false,
  hasChanges: true,
  isOnRootBranch: false,
  commits: [{ hash: 'old-commit', message: 'Old task work' }],
  changedFiles: ['old-file.ts'],
  diffSummary: 'Old changes',
};

const cleanContext = {
  ...branchContext,
  hasChanges: false,
  commits: [],
  changedFiles: [],
  diffSummary: '',
};

describe('Worktree context reset with real SQLite', () => {
  let sqlite: InstanceType<typeof Database>;
  let service: WorktreeContextService;
  let repoId: number;
  const worktreePath = '/tmp/reused-task-worktree';

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(__dirname, '../../drizzle') });
    const [project] = await db
      .insert(schema.projects)
      .values({ name: 'Test' })
      .returning();
    const [repo] = await db
      .insert(schema.repos)
      .values({
        projectId: project.id,
        name: 'repo',
        path: '/tmp/repo',
      })
      .returning();
    repoId = repo.id;
    service = new WorktreeContextService(
      db,
      {} as SessionsService,
      {} as TextAgentGenerationService,
    );
    jest.spyOn(service as any, 'readCurrentBranch').mockResolvedValue(null);
    jest
      .spyOn(service as any, 'collectBranchContext')
      .mockResolvedValue(branchContext);
    await db.insert(schema.worktreeContexts).values({
      repoId,
      worktreePath,
      rootRef: 'old-root',
      contextSentence: 'Previous task context.',
      generationStatus: 'ready',
      contextEnabled: false,
      generatedAt: '2026-04-24T08:00:00.000Z',
      lastUsedAt: '2026-04-24T09:00:00.000Z',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  it('handles concurrent context settings immediately after a task reset', async () => {
    await service.resetForTask(repoId, worktreePath);
    const snapshots = await Promise.all([
      service.updateContextEnabled(repoId, worktreePath, false),
      service.updateContextEnabled(repoId, worktreePath, false),
    ]);
    for (const snapshot of snapshots)
      expect(snapshot).toMatchObject({
        contextSentence: null,
        contextEnabled: false,
        hasRecord: true,
      });
  });

  it('preserves a context choice changed during generation', async () => {
    await service.resetForTask(repoId, worktreePath);
    const sentence = deferred<string>();
    const started = deferred<void>();
    jest.spyOn(service as any, 'generateSentence').mockImplementation(() => {
      started.resolve();
      return sentence.promise;
    });
    const generating = service.generate(repoId, worktreePath, {
      provider: 'codex',
    });
    await started.promise;
    try {
      expect(
        await service.updateContextEnabled(repoId, worktreePath, false),
      ).toMatchObject({
        generationStatus: 'generating',
        contextEnabled: false,
      });
    } finally {
      sentence.resolve('Current task context.');
    }
    expect(await generating).toMatchObject({
      contextSentence: 'Current task context.',
      generationStatus: 'ready',
      contextEnabled: false,
    });
  });

  it('keeps context disabled throughout preparation and releases the guard on failure', async () => {
    const preparation = deferred<void>();
    const started = deferred<void>();
    const collect = jest.spyOn(service as any, 'collectBranchContext');
    const generate = jest
      .spyOn(service as any, 'generateSentence')
      .mockResolvedValue('New context.');
    const pending = service.withTaskPreparation(
      repoId,
      worktreePath,
      async () => {
        started.resolve();
        await preparation.promise;
      },
    );
    const rejected = expect(pending).rejects.toThrow('Checkout failed');
    await started.promise;
    const snapshots = await Promise.all([
      service.getSnapshot(repoId, worktreePath),
      service.getCachedSnapshot(repoId, worktreePath),
      service.generate(repoId, worktreePath, {
        provider: 'codex',
        force: true,
      }),
      service.updateRootRef(repoId, worktreePath, 'old-root'),
      service.updateContextEnabled(repoId, worktreePath, true),
    ]);
    for (const snapshot of snapshots)
      expect(snapshot).toMatchObject({
        contextSentence: null,
        canGenerate: false,
        contextEnabled: false,
        hasRecord: false,
      });
    expect(collect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    preparation.reject(new Error('Checkout failed'));
    await rejected;
    expect(
      await service.generate(repoId, worktreePath, { provider: 'codex' }),
    ).toMatchObject({
      contextSentence: 'New context.',
      generationStatus: 'ready',
    });
  });

  it('does not launch the old LLM request if preparation starts after the generating record is written', async () => {
    const writeCompleted = deferred<void>();
    const releaseWrite = deferred<void>();
    const realUpsert = (service as any).upsertRecord.bind(service);
    jest
      .spyOn(service as any, 'upsertRecord')
      .mockImplementationOnce(async (...args) => {
        await realUpsert(...args);
        writeCompleted.resolve();
        await releaseWrite.promise;
      });
    const generate = jest
      .spyOn(service as any, 'generateSentence')
      .mockResolvedValue('Old sentence.');
    const oldGeneration = service.generate(repoId, worktreePath, {
      provider: 'codex',
      force: true,
    });
    await writeCompleted.promise;
    const preparation = deferred<void>();
    const started = deferred<void>();
    const preparing = service.withTaskPreparation(
      repoId,
      worktreePath,
      async () => {
        started.resolve();
        await preparation.promise;
      },
    );
    await started.promise;
    try {
      releaseWrite.resolve();
      expect(await oldGeneration).toMatchObject({
        contextSentence: null,
        canGenerate: false,
      });
      expect(generate).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
      await preparing;
    }
  });

  it('does not collect old branch context if a reset happens during the HEAD read', async () => {
    const branch = deferred<string | null>();
    const started = deferred<void>();
    jest
      .spyOn(service as any, 'readCurrentBranch')
      .mockImplementationOnce(() => {
        started.resolve();
        return branch.promise;
      });
    const collect = jest.spyOn(service as any, 'collectBranchContext');
    const generate = jest.spyOn(service as any, 'generateSentence');
    const pending = service.generate(repoId, worktreePath, {
      provider: 'codex',
      force: true,
    });
    await started.promise;
    await service.resetForTask(repoId, worktreePath);
    branch.resolve('previous-task-branch');
    expect(await pending).toMatchObject({
      contextSentence: null,
      hasRecord: false,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])(
    'ignores a late %s from the previous generation and preserves the new generation lock',
    async (outcome) => {
      const oldSentence = deferred<string>();
      const newSentence = deferred<string>();
      const oldStarted = deferred<void>();
      const newStarted = deferred<void>();
      const generate = jest
        .spyOn(service as any, 'generateSentence')
        .mockImplementationOnce(() => {
          oldStarted.resolve();
          return oldSentence.promise;
        })
        .mockImplementationOnce(() => {
          newStarted.resolve();
          return newSentence.promise;
        });
      const oldGeneration = service.generate(repoId, worktreePath, {
        provider: 'codex',
        force: true,
      });
      await oldStarted.promise;

      await service.resetForTask(repoId, worktreePath);
      expect(
        await service.getCachedSnapshot(repoId, worktreePath),
      ).toMatchObject({
        contextSentence: null,
        rootRef: null,
        generationStatus: 'idle',
        generatedAt: null,
        lastUsedAt: null,
        contextEnabled: true,
        hasRecord: false,
      });
      const newGeneration = service.generate(repoId, worktreePath, {
        provider: 'codex',
      });
      await newStarted.promise;
      if (outcome === 'success')
        oldSentence.resolve('Late previous task context.');
      else oldSentence.reject(new Error('Previous task generation failed'));
      expect(await oldGeneration).toMatchObject({
        contextSentence: null,
        generationStatus: 'generating',
      });
      expect(
        await service.getCachedSnapshot(repoId, worktreePath),
      ).toMatchObject({
        contextSentence: null,
        generationStatus: 'generating',
        contextEnabled: true,
      });

      const coalescedGeneration = service.generate(repoId, worktreePath, {
        provider: 'codex',
      });
      newSentence.resolve('Current task context.');
      const results = await Promise.all([newGeneration, coalescedGeneration]);
      expect(generate).toHaveBeenCalledTimes(2);
      for (const snapshot of results)
        expect(snapshot).toMatchObject({
          contextSentence: 'Current task context.',
          generationStatus: 'ready',
        });
      expect(
        await service.getCachedSnapshot(repoId, worktreePath),
      ).toMatchObject({
        contextSentence: 'Current task context.',
        generationStatus: 'ready',
      });
    },
  );

  it('discards pending snapshot reads and their main-branch stubs after reset', async () => {
    await service.resetForTask(repoId, worktreePath);
    const oldContext = deferred<typeof branchContext>();
    const started = deferred<void>();
    const collect = jest
      .spyOn(service as any, 'collectBranchContext')
      .mockImplementationOnce(() => {
        started.resolve();
        return oldContext.promise;
      })
      .mockResolvedValue(cleanContext);
    const oldSnapshot = service.getSnapshot(repoId, worktreePath);
    await started.promise;
    await service.resetForTask(repoId, worktreePath);

    expect(await service.getSnapshot(repoId, worktreePath)).toMatchObject({
      hasRecord: false,
      hasChanges: false,
    });
    oldContext.resolve({
      ...cleanContext,
      rootRef: 'previous-root',
      isOnRootBranch: true,
    });
    expect(await oldSnapshot).toMatchObject({
      rootRef: null,
      contextSentence: null,
      hasRecord: false,
    });
    expect(await service.getCachedSnapshot(repoId, worktreePath)).toMatchObject(
      {
        rootRef: null,
        contextSentence: null,
        hasRecord: false,
      },
    );
    expect(await service.getSnapshot(repoId, worktreePath)).toMatchObject({
      rootRef: 'main',
      hasChanges: false,
    });
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it.each(['updateRootRef', 'updateContextEnabled'] as const)(
    'prevents a pending %s from restoring the old sentence',
    async (method) => {
      const pendingRecord = deferred<unknown>();
      const started = deferred<void>();
      const findRecord = (service as any).findRecord.bind(service);
      const oldRecord = await findRecord(repoId, worktreePath);
      jest.spyOn(service as any, 'findRecord').mockImplementationOnce(() => {
        started.resolve();
        return pendingRecord.promise;
      });
      const mutation =
        method === 'updateRootRef'
          ? service.updateRootRef(repoId, worktreePath, 'old-custom-root')
          : service.updateContextEnabled(repoId, worktreePath, false);
      await started.promise;
      await service.resetForTask(repoId, worktreePath);
      pendingRecord.resolve(oldRecord);
      expect(await mutation).toMatchObject({
        contextSentence: null,
        rootRef: null,
        hasRecord: false,
        contextEnabled: true,
      });
      expect(
        await service.getCachedSnapshot(repoId, worktreePath),
      ).toMatchObject({
        contextSentence: null,
        rootRef: null,
        hasRecord: false,
        contextEnabled: true,
      });
    },
  );
});
