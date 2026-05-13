import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as pty from 'node-pty';
import { ActionPtyManager } from './action-pty-manager.service.js';
import {
  buildAugmentedEnv,
  buildTmuxInlineEnvPrefix,
  findBinary,
} from '../config/system-paths.js';

jest.mock('node-pty', () => ({
  spawn: jest.fn(),
}));

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

jest.mock('../config/system-paths.js', () => ({
  buildAugmentedEnv: jest.fn(),
  buildTmuxInlineEnvPrefix: jest.fn(() => "PATH='/repo/bin'"),
  findBinary: jest.fn(),
}));

type MockPty = EventEmitter & {
  kill: jest.Mock;
  onData: jest.Mock;
  onExit: jest.Mock;
  pid: number;
};

function createMockPty(): MockPty {
  const process = new EventEmitter() as MockPty;
  process.kill = jest.fn();
  process.onData = jest.fn();
  process.onExit = jest.fn();
  process.pid = 123;
  return process;
}

describe('ActionPtyManager', () => {
  const mockSpawn = jest.mocked(pty.spawn);
  const mockExecSync = jest.mocked(execSync);
  const mockBuildAugmentedEnv = jest.mocked(buildAugmentedEnv);
  const mockBuildTmuxInlineEnvPrefix = jest.mocked(buildTmuxInlineEnvPrefix);
  const mockFindBinary = jest.mocked(findBinary);

  let tmpDir: string;
  let manager: ActionPtyManager | null;

  beforeEach(() => {
    jest.resetAllMocks();
    manager = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elevenex-action-test-'));
    mockBuildAugmentedEnv.mockReturnValue({
      PATH: '/repo/bin:/usr/bin',
      SHELL: '/custom/zsh',
      PWD: '/backend/root',
      ELEVENEX_ACTION_TOKEN: 'abc 123',
      ELEVENEX_ACTION_QUOTED: "it's ok",
      'ELEVENEX-INVALID-KEY': 'ignored',
    });
    mockBuildTmuxInlineEnvPrefix.mockReturnValue("PATH='/repo/bin'");
    mockSpawn.mockReturnValue(createMockPty() as never);
  });

  afterEach(() => {
    manager?.onModuleDestroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns direct actions with the worktree-specific shell env and cwd', async () => {
    mockFindBinary.mockReturnValue(null);
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    await manager.start({
      id: 10,
      worktreePath: tmpDir,
      command: 'node -v',
    });

    expect(mockBuildAugmentedEnv).toHaveBeenCalledWith(process.env, tmpDir);
    expect(mockSpawn).toHaveBeenCalledWith('/custom/zsh', ['-lc', 'node -v'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: tmpDir,
      env: expect.objectContaining({
        PATH: '/repo/bin:/usr/bin',
        PWD: tmpDir,
        SHELL: '/custom/zsh',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }),
    });
  });

  it('reattaches tmux actions with the original worktree env and cwd', async () => {
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    mockExecSync.mockReturnValue(Buffer.from(''));
    manager = new ActionPtyManager();

    await expect(manager.reattach(42, tmpDir)).resolves.toBe(true);

    expect(mockBuildAugmentedEnv).toHaveBeenCalledWith(process.env, tmpDir);
    expect(mockSpawn).toHaveBeenCalledWith(
      'tail',
      ['-n', '0', '-f', path.join(os.tmpdir(), 'elevenex-action-42.log')],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: tmpDir,
        env: expect.objectContaining({
          PATH: '/repo/bin:/usr/bin',
          PWD: tmpDir,
          SHELL: '/custom/zsh',
        }),
      },
    );
  });

  it('starts tmux actions with the full augmented env inlined into the command wrapper', async () => {
    mockFindBinary.mockReturnValue('/usr/bin/tmux');
    mockExecSync.mockReturnValue(Buffer.from(''));
    manager = new ActionPtyManager();
    manager.registerPersistence({
      markRunning: jest.fn().mockResolvedValue(undefined),
      flushCurrentOutput: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
    });

    await manager.start({
      id: 11,
      worktreePath: tmpDir,
      command: 'printenv ELEVENEX_ACTION_TOKEN',
    });

    expect(mockBuildTmuxInlineEnvPrefix).toHaveBeenCalledWith(
      expect.objectContaining({
        PATH: '/repo/bin:/usr/bin',
        PWD: tmpDir,
        ELEVENEX_ACTION_TOKEN: 'abc 123',
        ELEVENEX_ACTION_QUOTED: "it's ok",
        TERM: 'xterm-256color',
      }),
      { mode: 'full' },
    );
    expect(mockBuildTmuxInlineEnvPrefix).toHaveBeenCalledTimes(1);

    const newSessionCall = mockExecSync.mock.calls.find(([command]) =>
      String(command).includes(' new-session '),
    );
    expect(newSessionCall?.[0]).toContain("PATH='\\''/repo/bin'\\''");
  });
});
