import { CodexSubagentMetadataLoader } from './codex-subagent-metadata.js';
import { CodexSubagentTracker } from './codex-subagents.js';

describe('CodexSubagentMetadataLoader', () => {
  it('coalesces child reads, bounds concurrency and skips queued stale work', async () => {
    const loader = new CodexSubagentMetadataLoader();
    const tracker = new CodexSubagentTracker();
    const finishes: (() => void)[] = [];
    let current = true;
    const read = jest.fn(
      () => new Promise<void>((resolve) => finishes.push(resolve)),
    );
    for (let id = 0; id < 10; id++) {
      loader.load(tracker, String(id), () => current, read);
      loader.load(tracker, String(id), () => current, read);
    }
    expect(read).toHaveBeenCalledTimes(4);
    finishes.splice(0).forEach((finish) => finish());
    await new Promise(setImmediate);
    expect(read).toHaveBeenCalledTimes(8);
    loader.load(tracker, '0', () => current, read);
    expect(read).toHaveBeenCalledTimes(8);
    current = false;
    finishes.splice(0).forEach((finish) => finish());
    await new Promise(setImmediate);
    expect(read).toHaveBeenCalledTimes(8);
    loader.dispose();
  });

  it('backs off failed metadata reads until a later event without polling', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const loader = new CodexSubagentMetadataLoader();
    try {
      const tracker = new CodexSubagentTracker();
      const read = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('Not saved yet'))
        .mockResolvedValue(undefined);
      loader.load(tracker, 'child', () => true, read);
      await new Promise(setImmediate);
      loader.load(tracker, 'child', () => true, read);
      expect(read).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1000);
      expect(read).toHaveBeenCalledTimes(1);
      loader.load(tracker, 'child', () => true, read);
      await new Promise(setImmediate);
      loader.load(tracker, 'child', () => true, read);
      expect(read).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      loader.dispose();
      jest.useRealTimers();
    }
  });

  it('disposes queued reads and invalidates in-flight replies', async () => {
    const loader = new CodexSubagentMetadataLoader();
    const tracker = new CodexSubagentTracker();
    const finishes: (() => void)[] = [];
    const applied = jest.fn();
    const read = jest.fn(async (current: () => boolean) => {
      await new Promise<void>((resolve) => finishes.push(resolve));
      if (current()) applied();
    });
    for (let id = 0; id < 6; id++)
      loader.load(tracker, String(id), () => true, read);
    loader.dispose();
    finishes.forEach((finish) => finish());
    await new Promise(setImmediate);
    loader.load(tracker, 'new-child', () => true, read);
    expect(read).toHaveBeenCalledTimes(4);
    expect(applied).not.toHaveBeenCalled();
  });
});
