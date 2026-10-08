import { TaskGitService } from './task-git.service';
import { execFileAsync } from '../terminal/async-process';

jest.mock('../terminal/async-process', () => ({ execFileAsync: jest.fn() }));

describe('TaskGitService remote refresh', () => {
  let service: TaskGitService;
  const execute = jest.mocked(execFileAsync);
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TaskGitService();
    jest
      .spyOn(service, 'remoteRef')
      .mockResolvedValue({
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
      });
    jest.spyOn(service, 'repositoryKey').mockResolvedValue('/repo/.git');
    jest.spyOn(service, 'resolve').mockResolvedValue('saved-revision');
  });

  it('coalesces fetches across checkouts and bounds network and credential waits', async () => {
    let release!: () => void;
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stdout: '', stderr: '' });
        }),
    );
    const first = service.refresh('/repo', 'origin/main');
    const second = service.refresh('/other-checkout', 'origin/main');
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'git',
      [
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
      ],
      expect.objectContaining({
        timeout: 30_000,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        }),
      }),
    );
    release();
    await Promise.all([first, second]);
    execute.mockResolvedValue({ stdout: '', stderr: '' });
    await service.refresh('/repo', 'origin/main');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('offers the saved revision after a timed-out fetch and permits a later retry', async () => {
    execute.mockRejectedValue(new Error('fetch timed out'));
    const refresh = service.refresh('/repo', 'origin/main');
    await expect(refresh).rejects.toMatchObject({
      response: { code: 'fetch_failed', savedCommit: 'saved-revision' },
    });
    execute.mockResolvedValue({ stdout: '', stderr: '' });
    await service.refresh('/repo', 'origin/main');
    expect(execute).toHaveBeenCalledTimes(2);
    await service.refresh('/repo', 'origin/main', true);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
