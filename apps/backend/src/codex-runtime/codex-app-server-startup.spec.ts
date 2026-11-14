import { ChildProcess, spawn } from 'child_process';
import { PassThrough } from 'node:stream';
import { buildAugmentedEnvAsync } from '../config/system-paths.js';
import { resolveCodexBinary, codexBinaryIdentity } from './codex-binary.js';
import { CodexAppServerClient } from './codex-app-server.js';

jest.mock('child_process', () => ({
  ChildProcess:
    jest.requireActual<typeof import('child_process')>('child_process')
      .ChildProcess,
  spawn: jest.fn(),
}));
jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnv: jest.fn(() => ({ PATH: '/launch/bin' })),
  buildAugmentedEnvAsync: jest.fn(),
  buildSpawnCommand: (command: string) => ({ command, shell: false }),
}));
jest.mock('./codex-binary.js', () => ({
  resolveCodexBinary: jest.fn(),
  codexBinaryIdentity: jest.fn(),
}));

function deferredEnvironment() {
  let resolve!: (env: NodeJS.ProcessEnv) => void;
  const promise = new Promise<NodeJS.ProcessEnv>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function appServerProcess() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: jest.fn(() => true),
  });
  child.stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as {
      id?: number;
      method: string;
    };
    if (request.id === undefined) return;
    const result =
      request.method === 'model/list'
        ? { data: [{ id: 'account-model', isDefault: true }] }
        : {};
    child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  });
  return child;
}

describe('Codex cold startup environment', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(codexBinaryIdentity).mockResolvedValue('current-cli');
  });

  it('coalesces initial model reads and resolves the CLI only after the login shell is ready', async () => {
    const environment = deferredEnvironment();
    jest.mocked(buildAugmentedEnvAsync).mockReturnValue(environment.promise);
    let shellReady = false;
    jest
      .mocked(resolveCodexBinary)
      .mockImplementation(() => (shellReady ? '/shell/bin/codex' : 'codex'));
    const child = appServerProcess();
    jest.mocked(spawn).mockReturnValue(child);
    const server = new CodexAppServerClient();
    const first = server.request('model/list', {});
    const second = server.request('model/list', {});
    try {
      await new Promise(setImmediate);
      expect(resolveCodexBinary).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(buildAugmentedEnvAsync).toHaveBeenCalledTimes(1);

      shellReady = true;
      const env = { PATH: '/shell/bin', CODEX_HOME: '/shell/account' };
      environment.resolve(env);
      await expect(first).resolves.toEqual({
        data: [{ id: 'account-model', isDefault: true }],
      });
      await expect(second).resolves.toEqual({
        data: [{ id: 'account-model', isDefault: true }],
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        '/shell/bin/codex',
        ['app-server', '--listen', 'stdio://'],
        {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        },
      );
      await server.request('model/list', {});
      expect(buildAugmentedEnvAsync).toHaveBeenCalledTimes(1);
    } finally {
      environment.resolve({});
      await Promise.allSettled([first, second]);
      server.onModuleDestroy();
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not spawn if shutdown occurs while the login shell is loading', async () => {
    const environment = deferredEnvironment();
    jest.mocked(buildAugmentedEnvAsync).mockReturnValue(environment.promise);
    jest.mocked(resolveCodexBinary).mockReturnValue('/shell/bin/codex');
    jest.mocked(spawn).mockReturnValue(appServerProcess());
    const server = new CodexAppServerClient();
    const ready = server.ensureReady();
    server.onModuleDestroy();
    environment.resolve({ PATH: '/shell/bin' });
    await expect(ready).rejects.toThrow('shutting down');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('can retry startup after environment assembly fails', async () => {
    jest
      .mocked(buildAugmentedEnvAsync)
      .mockRejectedValueOnce(new Error('Invalid subprocess environment'))
      .mockResolvedValue({ PATH: '/launch/bin' });
    jest.mocked(resolveCodexBinary).mockReturnValue('/launch/bin/codex');
    jest.mocked(spawn).mockReturnValue(appServerProcess());
    const server = new CodexAppServerClient();
    try {
      await expect(server.ensureReady()).rejects.toThrow(
        'Invalid subprocess environment',
      );
      expect(spawn).not.toHaveBeenCalled();
      await expect(server.request('model/list', {})).resolves.toEqual({
        data: [{ id: 'account-model', isDefault: true }],
      });
    } finally {
      server.onModuleDestroy();
    }
  });
});
