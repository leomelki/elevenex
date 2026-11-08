import { TerminalInputQueue } from "./terminal-input";

const target = { scopeId: "scope", taskId: 1, terminalId: 1, generation: "original" };

describe("User terminal input ownership", () => {
  it('accepts prediction only for queued input and stays non-idle until acknowledgement', async () => {
    let complete!: (accepted: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const queue = new TerminalInputQueue(send, vi.fn());
    expect(queue.push('unbound')).toBe(false);
    queue.bind(target); expect(queue.idle).toBe(true);
    expect(queue.push('typing')).toBe(true); expect(queue.idle).toBe(false);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(queue.idle).toBe(false);
    expect(queue.push('x'.repeat(128 * 1024 + 1))).toBe(false);
    complete(true);
    await vi.waitFor(() => expect(queue.idle).toBe(true));
    queue.dispose(); expect(queue.push('closed')).toBe(false);
  });
  it("serializes input without losing large Unicode pastes", async () => {
    const sent: string[] = [];
    let running = 0;
    const queue = new TerminalInputQueue(async (data) => {
      expect(running++).toBe(0);
      sent.push(data);
      await Promise.resolve();
      running--;
      return true;
    }, vi.fn());
    queue.bind(target);
    const data = "echo hello\r" + "🙂".repeat(18000);
    queue.push(data);
    await vi.waitFor(() => expect(sent.join("")).toBe(data));
    queue.dispose();
  });
  it("blocks after an unknown outcome and requires explicit resume without replaying input", async () => {
    const failed = vi.fn(),
      send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const queue = new TerminalInputQueue(send, failed);
    queue.bind(target);
    queue.push("first");
    queue.push("pending");
    await vi.waitFor(() => expect(queue.blocked).toBe(true));
    queue.push("do not replay");
    expect(send).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalled();
    queue.resume();
    queue.push("new");
    await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("new", target));
    queue.dispose();
  });
  it("clears pending input when the connection generation changes during a dispatch", async () => {
    let resolve!: (value: boolean) => void;
    const send = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const queue = new TerminalInputQueue(send, vi.fn());
    queue.bind(target);
    queue.push("a".repeat(16000));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    queue.resume();
    resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.blocked).toBe(false);
    queue.dispose();
  });
});

it("keeps interrupted input blocked across reconnect until the person resumes", async () => {
  let resolve!: (value: boolean) => void;
  const send = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    ),
    failed = vi.fn();
  const queue = new TerminalInputQueue(send, failed);
  queue.bind(target);
  queue.push("not replayed");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  queue.reconnect();
  resolve(false);
  await Promise.resolve();
  expect(queue.blocked).toBe(true);
  expect(failed).toHaveBeenCalled();
  queue.push("blocked");
  expect(send).toHaveBeenCalledTimes(1);
  queue.dispose();
});

it("discards the rest of a paste on process replacement and binds new typing explicitly", async () => {
  let resolve!: (accepted: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  const queue = new TerminalInputQueue(send, vi.fn());
  queue.bind(target);
  queue.push("x".repeat(9000));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const replacement = { ...target, generation: "replacement" };
  queue.bind(replacement);
  resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(queue.blocked).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith("x".repeat(4096), target);
  queue.push("discarded");
  queue.resume();
  queue.push("new");
  await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("new", replacement));
  resolve(true);
  queue.dispose();
});
