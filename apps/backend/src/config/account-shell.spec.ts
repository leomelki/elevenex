import { EventEmitter } from 'node:events';
import { AccountShellLookup } from './account-shell.js';

describe('isolated account-shell lookup', () => {
  const workers: (EventEmitter & {
    terminate: jest.Mock<Promise<number>, []>;
  })[] = [];
  let lookup: AccountShellLookup;
  beforeEach(() => {
    jest.useFakeTimers();
    workers.length = 0;
    lookup = new AccountShellLookup(100, () => {
      const worker = Object.assign(new EventEmitter(), {
        terminate: jest.fn<Promise<number>, []>().mockResolvedValue(0),
      });
      workers.push(worker);
      return worker;
    });
  });
  afterEach(async () => {
    lookup.dispose();
    await jest.runAllTimersAsync();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  it('shares concurrent NSS reads and caches a successful result', async () => {
    const first = lookup.read(),
      second = lookup.read();
    expect(workers).toHaveLength(1);
    workers[0].emit('message', '/custom/login-shell');
    expect(await first).toBe('/custom/login-shell');
    expect(await second).toBe('/custom/login-shell');
    expect(lookup.sync()).toBe('/custom/login-shell');
    expect(await lookup.read()).toBe('/custom/login-shell');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[0].eventNames()).toEqual([]);
  });
  it('bounds a stuck directory-service lookup and never creates repeated workers', async () => {
    const pending = lookup.read();
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(
      process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh',
    );
    await lookup.read();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('terminates an owned worker and settles readers on shutdown', async () => {
    const pending = lookup.read();
    lookup.dispose();
    await pending;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[0].eventNames()).toEqual([]);
  });
});
