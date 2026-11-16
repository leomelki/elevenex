import { DesktopBrowserService } from './desktop-browser.service.js';

describe('Desktop browser at-most-once mailbox', () => {
  let service: DesktopBrowserService;
  beforeEach(() => { service = new DesktopBrowserService(); });
  afterEach(() => service.onModuleDestroy());
  it('routes only the caller task, delivers once, and accepts only the current desktop receipt', async () => {
    service.poll(1, 'desktop', 'lease');
    const pending = service.request(1, 2, { kind: 'list' }, new AbortController().signal);
    const delivered = service.poll(1, 'desktop', 'lease');
    expect(delivered.command?.input).toEqual({ kind: 'list' });
    expect(service.poll(1, 'desktop', 'lease').command).toBeNull();
    await expect(service.request(2, 3, { kind: 'list' }, new AbortController().signal)).rejects.toThrow('No task browser');
    service.poll(1, 'other-desktop', 'lease', { id: delivered.command!.id, value: 'wrong' });
    service.poll(1, 'desktop', 'lease', { id: delivered.command!.id, value: { tabs: [], observation: 'withheld', message: 'safe' } });
    await expect(pending).resolves.toMatchObject({ tabs: [], observation: 'withheld' });
  });
  it('never replays delivered commands across disconnect/re-registration and cancels queued commands', async () => {
    service.poll(1, 'desktop', 'lease');
    const pending = service.request(1, 2, { kind: 'click' }, new AbortController().signal);
    service.poll(1, 'desktop', 'lease');
    const rejected = expect(pending).rejects.toThrow('disconnected');
    expect(service.poll(1, 'desktop', 'new-lease').command).toBeNull();
    await rejected;
    const controller = new AbortController();
    const cancelled = service.request(1, 2, { kind: 'click' }, controller.signal);
    const stopped = expect(cancelled).rejects.toThrow('cancelled'); controller.abort(); await stopped;
    expect(service.poll(1, 'desktop', 'new-lease').command).toBeNull();
  });
  it('withholds replies containing page text, screenshots or secret-bearing unknown fields', async () => {
    service.poll(1, 'desktop', 'lease');
    for (const field of ['screenshot', 'dom', 'accessibility', 'console', 'password']) {
      const result = service.request(1, 2, { kind: 'list' }, new AbortController().signal);
      const reject = expect(result).rejects.toThrow('withheld');
      const delivered = service.poll(1, 'desktop', 'lease');
      service.poll(1, 'desktop', 'lease', { id: delivered.command!.id, value: { tabs: [], observation: 'withheld', message: 'safe', [field]: 'private' } });
      await reject;
    }
  });
  it('bounds pending commands and drops a disconnected lease without input replay', async () => {
    jest.useFakeTimers();
    try {
      service.poll(1, 'desktop', 'lease');
      const controller = new AbortController();
      const calls = Array.from({ length: 16 }, () => service.request(1, 2, { kind: 'list' }, controller.signal).catch(error => error));
      await expect(service.request(1, 2, { kind: 'list' }, controller.signal)).rejects.toThrow('limit');
      jest.advanceTimersByTime(4000); await Promise.all(calls);
      expect(service.desktops(1)).toEqual([]);
    } finally { jest.useRealTimers(); }
  });
});
