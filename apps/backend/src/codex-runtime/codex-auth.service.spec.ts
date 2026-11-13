import { promises as fs } from 'fs';

const mockExecFile = jest.fn<
  Promise<{ stdout: string; stderr: string }>,
  [command: string, args: string[], options: unknown]
>();
jest.mock('child_process', () => {
  const actual =
    jest.requireActual<typeof import('child_process')>('child_process');
  const execFile = jest.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: Parameters<typeof mockExecFile>) => mockExecFile(...args),
  });
  return { ...actual, execFile };
});

import { CodexAuthService } from './codex-auth.service.js';

describe('Codex installation discovery', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    jest.spyOn(fs, 'readFile').mockResolvedValue('{}');
  });
  afterEach(() => jest.restoreAllMocks());

  it('waits for the first version check instead of reporting an installed CLI as missing', async () => {
    const service = new CodexAuthService();
    const statuses = jest.fn();
    service.on('status', statuses);
    let finish!: (output: { stdout: string; stderr: string }) => void;
    mockExecFile.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.getFastStatus();
    const second = service.getFastStatus();
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(statuses).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    finish({ stdout: 'codex test-version', stderr: '' });
    expect(await first).toMatchObject({
      installed: true,
      version: 'codex test-version',
    });
    expect(await second).toMatchObject({ installed: true });
    expect(statuses).toHaveBeenCalledWith(
      expect.objectContaining({ installed: true }),
    );
    await service.getFastStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('rechecks a missing CLI after three seconds', async () => {
    const service = new CodexAuthService();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    mockExecFile.mockRejectedValueOnce(new Error('ENOENT'));
    expect((await service.getFastStatus()).installed).toBe(false);
    await service.getFastStatus();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_003_001);
    mockExecFile.mockResolvedValueOnce({
      stdout: 'codex newly-installed',
      stderr: '',
    });
    expect((await service.getFastStatus()).installed).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
