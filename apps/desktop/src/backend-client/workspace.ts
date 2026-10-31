import type {
  BackendResult,
  InvokeContracts,
  WorkspaceAppearance,
  WorkspacePage,
  WorkspaceProject,
  WorkspaceProjectDetail,
  WorkspaceRepository,
  WorkspaceRepositorySetup,
  WorkspaceTask,
  WorkspaceTaskSetupIssue,
  WorkspaceSession,
  WorkspaceStage,
  WorkspaceGitSummary,
  WorkspaceCommitPreview,
  WorkspaceCommitSelection,
} from '@elevenex/shared';
import { handleForWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';
import {
  invalidResponse,
  requestBackendJson,
  type BackendEndpoint,
} from './transport';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidResponse();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw invalidResponse();
  return value;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw invalidResponse();
  return value;
}
function nullable(value: unknown, max = 4096): string | null {
  return value === null ? null : text(value, max);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidResponse();
  return value;
}
function stage(value: unknown): WorkspaceStage {
  if (value !== 'planned' && value !== 'active' && value !== 'waiting')
    throw invalidResponse();
  return value;
}
function appearance(value: unknown): WorkspaceAppearance {
  const raw = object(value),
    look = raw['look'],
    hue = raw['hue'];
  if (
    look !== undefined &&
    look !== 'letters' &&
    look !== 'emoji' &&
    look !== 'icon'
  )
    throw invalidResponse();
  if (
    hue !== undefined &&
    hue !== 'ocean' &&
    hue !== 'pine' &&
    hue !== 'plum' &&
    hue !== 'rust' &&
    hue !== 'steel' &&
    hue !== 'rose'
  )
    throw invalidResponse();
  return {
    ...(look === undefined ? {} : { look }),
    ...(hue === undefined ? {} : { hue }),
    ...(raw['emoji'] === undefined ? {} : { emoji: text(raw['emoji'], 64) }),
    ...(raw['icon'] === undefined ? {} : { icon: text(raw['icon'], 64) }),
  };
}
function project(value: unknown): WorkspaceProject {
  const raw = object(value);
  return {
    id: id(raw['id']),
    name: text(raw['name'], 100),
    agentInstructions: nullable(raw['agentInstructions'], 100000),
    ...(raw['appearance'] === undefined
      ? {}
      : { appearance: appearance(raw['appearance']) }),
  };
}
function repository(value: unknown): WorkspaceRepository {
  const raw = object(value);
  return {
    id: id(raw['id']),
    projectId: id(raw['projectId']),
    name: text(raw['name'], 256),
    path: text(raw['path']),
    defaultBase: nullable(raw['defaultBase'], 240),
  };
}
function setupIssue(value: unknown): WorkspaceTaskSetupIssue {
  const raw = object(value), code = raw['code'];
  if (code !== 'external-checkout' && code !== 'branch-in-use' && code !== 'environment-busy' && code !== 'other') throw invalidResponse();
  const path = raw['workspacePath'];
  if (path !== undefined && /[\0\r\n]/.test(text(path, 4096))) throw invalidResponse();
  return {
    code,
    message: required(raw['message'], 500),
    canUseSnapshot: boolean(raw['canUseSnapshot']),
    ...(raw['canExceedWorktreeLimit'] === undefined ? {} : { canExceedWorktreeLimit: boolean(raw['canExceedWorktreeLimit']) }),
    ...(path === undefined ? {} : { workspacePath: text(path, 4096) }),
  };
}
export function parseWorkspaceTask(value: unknown): WorkspaceTask {
  const raw = object(value),
    state = raw['state'];
  if (
    state !== 'preparing' &&
    state !== 'ready' &&
    state !== 'failed' &&
    state !== 'finishing' &&
    state !== 'releasing' &&
    state !== 'released' &&
    state !== 'finished'
  )
    throw invalidResponse();
  return {
    ...(raw['projectName'] === undefined
      ? {}
      : { projectName: text(raw['projectName'], 100) }),
    ...(raw['projectRepositoryCount'] === undefined
      ? {}
      : { projectRepositoryCount: id(raw['projectRepositoryCount']) }),
    ...(raw['repoName'] === undefined
      ? {}
      : { repoName: text(raw['repoName'], 256) }),
    id: id(raw['id']),
    repoId: id(raw['repoId']),
    projectId: id(raw['projectId']),
    name: text(raw['name'], 160),
    branchName: text(raw['branchName'], 240),
    state,
    ...(raw['setupIssue'] === undefined ? {} : { setupIssue: setupIssue(raw['setupIssue']) }),
    stage: stage(raw['stage']),
    archivedAt: nullable(raw['archivedAt'], 64),
    updatedAt: text(raw['updatedAt'], 64),
  };
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidResponse();
  return value;
}
function commitSelection(value: unknown): WorkspaceCommitSelection {
  const raw = object(value);
  const paths = (value: unknown): readonly string[] => {
    if (!Array.isArray(value) || value.length > 1000) throw invalidResponse();
    if (value.reduce((bytes: number, path: unknown) => bytes + (typeof path === 'string' ? path.length : 0), 0) > 65536) throw invalidResponse();
    return value.map(value => { const path = text(value, 4096); if (!path || path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) throw invalidResponse(); return path; });
  };
  return { includeUnstaged: boolean(raw['includeUnstaged']), excluded: paths(raw['excluded']), includedSecrets: paths(raw['includedSecrets']) };
}
function commitPreview(value: unknown): WorkspaceCommitPreview {
  const raw = object(value), selected = object(raw['selected']);
  if (!Array.isArray(raw['items']) || raw['items'].length > 100 || !Array.isArray(raw['running']) || raw['running'].length > 20) throw invalidResponse();
  const revision = text(raw['revision'], 64), cursor = nullable(raw['nextCursor'], 9);
  if (!/^[a-f0-9]{64}$/.test(revision) || (cursor !== null && !/^[1-9]\d{0,8}$/.test(cursor))) throw invalidResponse();
  return { taskId: id(raw['taskId']), revision, nextCursor: cursor, total: count(raw['total']), matches: count(raw['matches']), unstaged: count(raw['unstaged']), running: raw['running'].map(name => text(name, 256)), ...(raw['runningCount'] === undefined ? {} : { runningCount: count(raw['runningCount']) }),
    selected: { files: count(selected['files']), add: count(selected['add']), del: count(selected['del']), staged: count(selected['staged']), unstaged: count(selected['unstaged']) },
    items: raw['items'].map(value => { const file = object(value); if (!['M','A','D','R','U'].includes(String(file['status'])) || (file['flag'] !== undefined && file['flag'] !== 'secrets')) throw invalidResponse(); return { path: text(file['path'], 4096), status: text(file['status'], 1), add: count(file['add']), del: count(file['del']), staged: boolean(file['staged']), ...(file['flag'] === 'secrets' ? { flag: 'secrets' as const } : {}) }; }),
  };
}
function gitSummary(value: unknown): WorkspaceGitSummary {
  const raw = object(value);
  const count = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw invalidResponse();
    return value;
  };
  return {
    taskId: id(raw['taskId']),
    branch: text(raw['branch'], 240),
    upstream: nullable(raw['upstream'], 480),
    ahead: count(raw['ahead']),
    behind: count(raw['behind']),
    files: count(raw['files']),
    additions: count(raw['additions']),
    deletions: count(raw['deletions']),
    conflicted: boolean(raw['conflicted']),
    ...(raw['commitPhase'] === undefined ? {} : { commitPhase: commitPhase(raw['commitPhase']) }),
    ...(raw['changesRevision'] === undefined ? {} : { changesRevision: changesRevision(raw['changesRevision']) }),
  };
}
function changesRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalidResponse();
  return value;
}
function commitPhase(value: unknown): 'writing' | 'committing' | 'pushing' {
  if (value !== 'writing' && value !== 'committing' && value !== 'pushing') throw invalidResponse();
  return value;
}
function session(value: unknown): WorkspaceSession {
  const raw = object(value);
  return {
    id: id(raw['id']),
    taskId: id(raw['taskId']),
    repoId: id(raw['repoId']),
    name: text(raw['name'], 160),
    status: text(raw['status'], 64),
    provider: text(raw['provider'], 64),
    updatedAt: text(raw['updatedAt'], 64),
  };
}
export function parseWorkspacePage<T>(
  value: unknown,
  map: (value: unknown) => T,
): WorkspacePage<T> {
  const raw = object(value);
  if (!Array.isArray(raw['items']) || raw['items'].length > 100)
    throw invalidResponse();
  const cursor = nullable(raw['nextCursor'], 20);
  if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) throw invalidResponse();
  return { items: raw['items'].map(map), nextCursor: cursor };
}
function detail(value: unknown): WorkspaceProjectDetail {
  const raw = object(value);
  const result = {
    project: project(raw['project']),
    repositories: parseWorkspacePage(raw['repositories'], repository),
  };
  if (
    result.repositories.items.some(
      (repo) => repo.projectId !== result.project.id,
    )
  )
    throw invalidResponse();
  return result;
}
function accepted(value: unknown): { readonly accepted: true } {
  if (object(value)['accepted'] !== true) throw invalidResponse();
  return { accepted: true };
}
function required(value: unknown, max: number): string {
  const result = text(value, max).trim();
  if (!result) throw new Error('A nonempty value is required.');
  return result;
}
function query(value: unknown): { limit: number; cursor?: string } {
  const raw = object(value),
    limit = raw['limit'] === undefined ? 50 : id(raw['limit']);
  if (limit > 100) throw new Error('Page limit exceeds 100.');
  const cursor =
    raw['cursor'] === undefined ? undefined : required(raw['cursor'], 20);
  if (cursor && !/^[1-9]\d*$/.test(cursor)) throw new Error('Invalid cursor.');
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}
function queryString(values: object): string {
  return new URLSearchParams(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}
type WorkspaceChannel = Extract<keyof InvokeContracts, `workspace:${string}`>;

/** Named domain adapters; resource IDs and query bounds are checked before transport. */
export function registerWorkspaceIpc(
  client: BackendClient,
  trusted: TrustedSender,
): () => void {
  const stops: (() => void)[] = [];
  function register<C extends WorkspaceChannel>(
    channel: C,
    handler: (
      windowId: number,
      scopeId: string,
      input: InvokeContracts[C]['args'][1],
    ) => InvokeContracts[C]['result'] | Promise<InvokeContracts[C]['result']>,
  ) {
    stops.push(
      handleForWindow(channel, trusted, (windowId, ...args) => {
        const scope = args[0];
        if (
          args.length !== 2 ||
          typeof scope !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(scope)
        )
          throw new Error('A backend scope is required.');
        return handler(windowId, scope, args[1]);
      }),
    );
  }
  function read<T>(
    windowId: number,
    scope: string,
    path: string,
    parse: (value: unknown) => T,
  ): Promise<BackendResult<T>> {
    return client.execute(
      windowId,
      scope,
      path,
      false,
      async (endpoint, signal) =>
        parse(
          await requestBackendJson(
            endpoint,
            { path, limit: 768 * 1024 },
            signal,
          ),
        ),
    );
  }
  function write<T>(
    windowId: number,
    scope: string,
    path: string,
    body: object | undefined,
    parse: (value: unknown) => T,
    method: 'POST' | 'PATCH' = 'POST',
    timeoutMs = 30000,
    conflictMessages?: Readonly<Record<string, string>>,
  ): Promise<BackendResult<T>> {
    return client.execute(
      windowId,
      scope,
      null,
      true,
      async (endpoint: BackendEndpoint, signal) =>
        parse(
          await requestBackendJson(
            endpoint,
            {
              path,
              method,
              limit: 768 * 1024,
              ...(conflictMessages === undefined ? {} : { conflictMessages }),
              ...(body === undefined ? {} : { body }),
            },
            signal,
          ),
        ),
      timeoutMs,
    );
  }
  const base = '/api/desktop-workspace';
  stops.push(
    handleForWindow('workspace:revision', trusted, (windowId, ...args) => {
      if (
        args.length !== 1 ||
        typeof args[0] !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(args[0])
      )
        throw new Error('A backend scope is required.');
      return read(windowId, args[0], `${base}/revision`, (value) => {
        const response = object(value);
        if (response['version'] !== 1) throw invalidResponse();
        const revision = response['revision'];
        if (
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        )
          throw invalidResponse();
        if (response['sessionArchiveHistory'] !== undefined && response['sessionArchiveHistory'] !== true) throw invalidResponse();
        if (response['sessionArchive'] !== undefined && response['sessionArchive'] !== true) throw invalidResponse();
        if (response['commitPanel'] !== undefined && response['commitPanel'] !== true) throw invalidResponse();
        return { revision, version: 1 as const, ...(response['sessionArchiveHistory'] === true ? { sessionArchiveHistory: true as const } : {}), ...(response['sessionArchive'] === true ? { sessionArchive: true as const } : {}), ...(response['commitPanel'] === true ? { commitPanel: true as const } : {}) };
      });
    }),
  );
  register('workspace:close-preview', (window, scope, input) => {
    const taskId = id(input);
    return read(
      window,
      scope,
      `${base}/tasks/${taskId}/close-preview`,
      (value) => {
        const raw = object(value);
        const count = (value: unknown) => {
          if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            throw invalidResponse();
          return value;
        };
        if (raw['taskId'] !== taskId) throw invalidResponse();
        return {
          taskId,
          sessions: count(raw['sessions']),
          running: count(raw['running']),
          terminals: count(raw['terminals']),
          actions: count(raw['actions']),
          unpushed: count(raw['unpushed']),
          ...(raw['uncommitted'] === undefined ? {} : { uncommitted: count(raw['uncommitted']) }),
        };
      },
    );
  });
  register('workspace:commit-preview', (window, scope, input) => {
    const raw = object(input), taskId = id(raw['taskId']), selection = commitSelection(raw);
    const cursor = raw['cursor'] === undefined ? undefined : required(raw['cursor'], 9);
    if (cursor && !/^[1-9]\d{0,8}$/.test(cursor)) throw invalidResponse();
    const body = { ...selection, query: raw['query'] === undefined ? '' : text(raw['query'], 4096), ...(cursor ? { cursor } : {}) };
    const key = JSON.stringify(['commit-preview', taskId, body]);
    return client.execute(window, scope, key, false, async (endpoint, signal) => {
      const result = commitPreview(await requestBackendJson(endpoint, { path: base + '/tasks/' + taskId + '/commit-preview', method: 'POST', body, limit: 768 * 1024 }, signal));
      if (result.taskId !== taskId) throw invalidResponse();
      return result;
    }, 30000);
  });
  register('workspace:git', (window, scope, input) => {
    const taskId = id(input);
    return read(window, scope, `${base}/tasks/${taskId}/git`, (value) => {
      const result = gitSummary(value);
      if (result.taskId !== taskId) throw invalidResponse();
      return result;
    });
  });
  register('workspace:git-action', (window, scope, input) => {
    const raw = object(input),
      taskId = id(raw['taskId']),
      type = raw['type'];
    if (raw['selection'] !== undefined && (typeof raw['revision'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['revision']))) throw invalidResponse();
    if (
      type !== 'commit' &&
      type !== 'push' &&
      type !== 'sync' &&
      type !== 'rename-branch'
    )
      throw new Error('Unsupported git action.');
    return write(
      window,
      scope,
      `${base}/tasks/${taskId}/git`,
      {
        type,
        ...(type === 'commit'
          ? { message: text(raw['message'], 4000), ...(raw['selection'] === undefined ? {} : { selection: commitSelection(raw['selection']), revision: required(raw['revision'], 64) }), ...(raw['push'] === undefined ? {} : { push: boolean(raw['push']) }) }
          : {}),
        ...(type === 'rename-branch'
          ? { branchName: required(raw['branchName'], 240) }
          : {}),
      },
      value => { const result = gitSummary(value); if (result.taskId !== taskId) throw invalidResponse(); return result; },
      'POST',
      type === 'commit' ? 180000 : 30000,
    );
  });
  register('workspace:restore-project', (window, scope, input) =>
    write(
      window,
      scope,
      `${base}/projects/${id(input)}/restore`,
      undefined,
      accepted,
    ),
  );
  register('workspace:delete-project', (window, scope, input) =>
    write(
      window,
      scope,
      `${base}/projects/${id(input)}/delete`,
      undefined,
      accepted,
      'POST',
      180000,
      {
        active_tasks: 'A task opened while this project was being deleted. Try deleting the project again.',
        project_cleanup_failed: 'Could not stop all project processes. The project was kept. Try deleting it again.',
      },
    ),
  );
  register('workspace:projects', (window, scope, input) =>
    read(
      window,
      scope,
      `${base}/projects?${queryString(query(input))}`,
      (value) => parseWorkspacePage(value, project),
    ),
  );
  register('workspace:project-name-availability', (window, scope, input) =>
    read(window, scope, `${base}/projects/name-availability?${new URLSearchParams({ name: required(input, 100) })}`, value => ({ available: boolean(object(value)['available']) })),
  );
  register('workspace:project', (window, scope, input) => {
    const projectId = id(input);
    return read(window, scope, `${base}/projects/${projectId}`, (value) => {
      const result = detail(value);
      if (result.project.id !== projectId) throw invalidResponse();
      return result;
    });
  });
  register('workspace:tasks', (window, scope, input) => {
    const raw = object(input),
      projectId = raw['projectId'] === null ? null : id(raw['projectId']),
      state = raw['state'] ?? 'active';
    if (state !== 'active' && state !== 'finished')
      throw new Error('Invalid task state.');
    return read(
      window,
      scope,
      `${base}/tasks?${queryString({ ...query(raw), projectId, state })}`,
      (value) => {
        const result = parseWorkspacePage(value, parseWorkspaceTask);
        if (
          projectId !== null &&
          result.items.some((task) => task.projectId !== projectId)
        )
          throw invalidResponse();
        return result;
      },
    );
  });
  register('workspace:task', (window, scope, input) => {
    const taskId = id(input);
    return read(window, scope, `${base}/tasks/${taskId}`, (value) => {
      const task = parseWorkspaceTask(value);
      if (task.id !== taskId) throw invalidResponse();
      return task;
    });
  });
  register('workspace:sessions', (window, scope, input) => {
    const raw = object(input),
      taskId = id(raw['taskId']);
    if (raw['order'] !== undefined && raw['order'] !== 'latest') throw invalidResponse();
    if (raw['state'] !== undefined && raw['state'] !== 'normal' && raw['state'] !== 'archived') throw invalidResponse();
    return read(
      window,
      scope,
      `${base}/tasks/${taskId}/sessions?${queryString({ ...query(raw), ...(raw['order'] === 'latest' ? { order: 'latest' } : {}), ...(raw['state'] === undefined ? {} : { state: raw['state'] }) })}`,
      (value) => {
        const result = parseWorkspacePage(value, session);
        if (result.items.some((session) => session.taskId !== taskId || (raw['state'] === 'archived' && session.status !== 'archived') || (raw['state'] === 'normal' && session.status === 'archived')))
          throw invalidResponse();
        return result;
      },
    );
  });
  register('workspace:create-project', (window, scope, input) => {
    const raw = object(input),
      additionalPaths = raw['additionalPaths'] ?? [];
    if (!Array.isArray(additionalPaths) || additionalPaths.length > 19)
      throw new Error('At most 20 repositories are allowed.');
    const paths = [
      required(raw['path'], 4096),
      ...additionalPaths.map((path) => required(path, 4096)),
    ];
    let repositorySetup: WorkspaceRepositorySetup[] | undefined;
    if (raw['repositorySetup'] !== undefined) {
      const setup = raw['repositorySetup'];
      if (!Array.isArray(setup) || setup.length !== paths.length)
        throw new Error('Invalid repository setup.');
      repositorySetup = setup.map((value, index) => {
        const entry = object(value),
          path = required(entry['path'], 4096);
        if (
          path !== paths[index] ||
          (entry['initialize'] !== undefined &&
            typeof entry['initialize'] !== 'boolean') ||
          (entry['clone'] !== undefined && entry['initialize'])
        )
          throw new Error('Invalid repository setup.');
        return {
          path,
          ...(entry['clone'] === undefined
            ? {}
            : { clone: required(entry['clone'], 4096) }),
          ...(entry['initialize'] === undefined
            ? {}
            : { initialize: boolean(entry['initialize']) }),
        };
      });
    }
    return write(
      window,
      scope,
      `${base}/projects`,
      {
        ...(repositorySetup === undefined ? {} : { repositorySetup }),
        name: required(raw['name'], 100),
        path: required(raw['path'], 4096),
        additionalPaths: additionalPaths.map((path) => required(path, 4096)),
        ...(raw['appearance'] === undefined
          ? {}
          : { appearance: appearance(raw['appearance']) }),
      },
      detail,
      'POST',
      130_000,
    ).then((result) => {
      if (!result.ok && result.error.code === 'http') {
        const message =
          result.error.status === 409
            ? 'Project setup conflicts with an existing folder or project. Check the repository selection.'
            : result.error.status === 400
              ? 'Project could not be created. Check the repository folders, Git access and permissions.'
              : result.error.message;
        return { ok: false, error: { ...result.error, message } };
      }
      return result;
    });
  });
  register('workspace:add-repository', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/projects/${id(raw['projectId'])}/repositories`,
      { path: required(raw['path'], 4096) },
      detail,
    );
  });
  register('workspace:update-project', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/projects/${id(raw['projectId'])}`,
      {
        ...(raw['name'] === undefined
          ? {}
          : { name: required(raw['name'], 100) }),
        ...(raw['agentInstructions'] === undefined
          ? {}
          : { agentInstructions: text(raw['agentInstructions'], 100000) }),
        ...(raw['appearance'] === undefined
          ? {}
          : { appearance: appearance(raw['appearance']) }),
      },
      detail,
      'PATCH',
    );
  });
  register('workspace:archive-project', (window, scope, input) =>
    write(
      window,
      scope,
      `${base}/projects/${id(input)}/archive`,
      undefined,
      accepted,
    ),
  );
  register('workspace:create-task', (window, scope, input) => {
    const raw = object(input),
      mode = raw['mode'] ?? 'new';
    if (mode !== 'new' && mode !== 'existing')
      throw new Error('Invalid branch mode.');
    return write(
      window,
      scope,
      `${base}/tasks`,
      {
        repoId: id(raw['repoId']),
        name: required(raw['name'], 160),
        requestId: required(raw['requestId'], 100),
        mode,
        ...(raw['branchName'] === undefined
          ? {}
          : { branchName: required(raw['branchName'], 240) }),
        ...(raw['baseRef'] === undefined
          ? {}
          : { baseRef: required(raw['baseRef'], 240) }),
      },
      parseWorkspaceTask,
    );
  });
  register('workspace:archive-session', (window, scope, input) => {
    const raw = object(input), taskId = id(raw['taskId']), sessionId = id(raw['sessionId']);
    return write(window, scope, `${base}/tasks/${taskId}/sessions/${sessionId}/archive`, { confirmStop: boolean(raw['confirmStop']) }, accepted);
  });
  register('workspace:restore-session', (window, scope, input) => {
    const raw = object(input), taskId = id(raw['taskId']), sessionId = id(raw['sessionId']);
    return write(window, scope, `${base}/tasks/${taskId}/sessions/${sessionId}/restore`, undefined, value => {
      const restored = session(value);
      if (restored.id !== sessionId || restored.taskId !== taskId || restored.status === 'archived') throw invalidResponse();
      return restored;
    });
  });
  register('workspace:create-session', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/sessions`,
      {
        taskId: id(raw['taskId']),
        ...(raw['name'] === undefined
          ? {}
          : { name: required(raw['name'], 160) }),
      },
      session,
    );
  });
  register('workspace:rename-task', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/tasks/${id(raw['taskId'])}`,
      { name: required(raw['name'], 160) },
      parseWorkspaceTask,
      'PATCH',
    );
  });
  register('workspace:set-stage', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/tasks/${id(raw['taskId'])}/stage`,
      { stage: stage(raw['stage']) },
      parseWorkspaceTask,
      'PATCH',
    );
  });
  register('workspace:finish-task', (window, scope, input) => {
    const raw = object(input);
    return write(
      window,
      scope,
      `${base}/tasks/${id(raw['taskId'])}/finish`,
      { confirmStop: boolean(raw['confirmStop']) },
      parseWorkspaceTask,
    );
  });
  // Recovery is an optional third argument; keep existing scope + numeric ID calls valid.
  stops.push(handleForWindow('workspace:retry-task', trusted, (window, ...args) => {
    const [scope, taskId, recovery] = args;
    if ((args.length !== 2 && args.length !== 3) || typeof scope !== 'string' || !/^[a-f0-9-]{36}$/.test(scope)) throw new Error('A backend scope is required.');
    if (args.length === 3 && recovery !== undefined && recovery !== 'use-existing' && recovery !== 'snapshot' && recovery !== 'exceed-worktree-limit') throw new Error('Invalid task recovery scope arguments.');
    const targetId = id(taskId);
    return write(window, scope, `${base}/tasks/${targetId}/retry`, recovery === undefined ? undefined : { recovery }, value => {
      const task = parseWorkspaceTask(value);
      if (task.id !== targetId) throw invalidResponse();
      return task;
    });
  }));
  register('workspace:reopen-task', (window, scope, input) =>
    write(
      window,
      scope,
      `${base}/tasks/${id(input)}/reopen`,
      undefined,
      parseWorkspaceTask,
    ),
  );
  register('workspace:branches', (window, scope, input) => {
    const raw = object(input),
      repoId = id(raw['repoId']),
      limit = raw['limit'] === undefined ? 50 : id(raw['limit']);
    if (limit > 100) throw new Error('Branch limit exceeds 100.');
    return read(
      window,
      scope,
      `${base}/branches?${queryString({ repoId, query: raw['query'] === undefined ? '' : text(raw['query'], 240), limit })}`,
      (value) => {
        if (!Array.isArray(value) || value.length > limit)
          throw invalidResponse();
        return value.map((value) => {
          const branch = object(value);
          return {
            name: text(branch['name'], 240),
            current: boolean(branch['current']),
            isDefault: boolean(branch['isDefault']),
            defaultBase: nullable(branch['defaultBase'], 240),
            heldTaskName: nullable(branch['heldTaskName'], 160),
          };
        });
      },
    );
  });
  register('workspace:folders', (window, scope, input) => {
    const raw = object(input),
      limit = raw['limit'] === undefined ? 20 : id(raw['limit']);
    if (limit > 50) throw new Error('Folder limit exceeds 50.');
    return read(
      window,
      scope,
      `${base}/folders?${queryString({ query: text(raw['query'], 4096), limit })}`,
      (value) => {
        if (!Array.isArray(value) || value.length > limit)
          throw invalidResponse();
        return value.map((value) => {
          const folder = object(value);
          return {
            path: text(folder['path']),
            name: text(folder['name'], 256),
            git: nullable(folder['git'], 256),
            dir: boolean(folder['dir']),
            ...(folder['clone'] === undefined
              ? {}
              : { clone: required(folder['clone'], 4096) }),
          };
        });
      },
    );
  });
  return () => {
    for (const stop of stops) stop();
  };
}
