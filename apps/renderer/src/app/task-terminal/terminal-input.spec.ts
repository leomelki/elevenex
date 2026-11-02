import { TerminalInputQueue } from "./terminal-input";

describe("User terminal input ownership", () => {
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
    const data = "echo hello\r" + "🙂".repeat(18000);
    queue.push(data);
    await vi.waitFor(() => expect(sent.join("")).toBe(data));
    queue.dispose();
  });
  it("blocks after an unknown outcome and requires explicit resume without replaying input", async () => {
    const failed = vi.fn(),
      send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const queue = new TerminalInputQueue(send, failed);
    queue.push("first");
    queue.push("pending");
    await vi.waitFor(() => expect(queue.blocked).toBe(true));
    queue.push("do not replay");
    expect(send).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalled();
    queue.resume();
    queue.push("new");
    await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("new"));
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
