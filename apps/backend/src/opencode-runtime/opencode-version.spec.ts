import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import {
  clearOpenCodeVersionCache,
  openCodeMajorVersion,
} from './opencode-version.js';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('node:fs/promises', () => ({ realpath: jest.fn(), stat: jest.fn() }));

describe('OpenCode version caching', () => {
  let child: EventEmitter & {
    stdout: EventEmitter;
    stderr: { resume: jest.Mock };
    kill: jest.Mock;
  };
  beforeEach(() => {
    jest.resetAllMocks();
    clearOpenCodeVersionCache();
    jest.mocked(realpath).mockResolvedValue('/bin/opencode');
    jest
      .mocked(stat)
      .mockResolvedValue({
        dev: 1,
        ino: 1,
        size: 1,
        mtimeMs: 1,
        ctimeMs: 1,
      } as never);
    jest.mocked(spawn).mockImplementation(() => {
      child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: { resume: jest.fn() },
        kill: jest.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('2.0.26\n'));
        child.emit('exit', 0);
      });
      return child as never;
    });
  });

  it('shares concurrent probes and reuses successful results for unchanged binaries', async () => {
    await Promise.all([
      openCodeMajorVersion('/bin/opencode', '/repo/a', {}),
      openCodeMajorVersion('/bin/opencode', '/repo/b', {}),
    ]);
    expect(await openCodeMajorVersion('/bin/opencode', '/repo/c', {})).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rechecks an executable replaced at the same path', async () => {
    await openCodeMajorVersion('/bin/opencode', '/repo', {});
    jest
      .mocked(stat)
      .mockResolvedValue({
        dev: 1,
        ino: 2,
        size: 1,
        mtimeMs: 1,
        ctimeMs: 1,
      } as never);
    await openCodeMajorVersion('/bin/opencode', '/repo', {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('rechecks launcher targets on explicit refresh', async () => {
    await openCodeMajorVersion('/bin/opencode', '/repo', {});
    clearOpenCodeVersionCache();
    await openCodeMajorVersion('/bin/opencode', '/repo', {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('retries failures without caching an unavailable CLI', async () => {
    jest.mocked(spawn).mockImplementationOnce(() => {
      const failed = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: { resume: jest.fn() },
        kill: jest.fn(),
      });
      queueMicrotask(() => failed.emit('error', new Error('missing')));
      return failed as never;
    });
    await expect(
      openCodeMajorVersion('/bin/opencode', '/repo', {}),
    ).rejects.toThrow('missing');
    expect(await openCodeMajorVersion('/bin/opencode', '/repo', {})).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('does not retain a version when executable identity is unavailable', async () => {
    jest.mocked(realpath).mockRejectedValue(new Error('unresolved PATH'));
    await openCodeMajorVersion('opencode', '/repo', { PATH: '/bin' });
    await openCodeMajorVersion('opencode', '/repo', { PATH: '/bin' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
