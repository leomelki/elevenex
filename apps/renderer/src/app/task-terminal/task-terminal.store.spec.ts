import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import type {
  BackendResult,
  TaskTerminal,
  TaskTerminalOutput,
  TaskTerminalList,
} from "@elevenex/shared";
import {
  BackendClientService,
  ELEVENEX_BRIDGE,
} from "../backend/backend-client.service";
import { TaskTerminalStore } from "./task-terminal.store";

const page = (taskId: number): BackendResult<TaskTerminalList> => ({
  ok: true,
  value: { taskId, terminals: [], scripts: [], limit: 16 },
});
function setup() {
  const connection = signal({
    revision: 1,
    scope: { id: "scope", environment: { kind: "local" as const } },
  });
  const bridge = {
    taskTerminalList: vi.fn(async (_scope: string, task: number) => page(task)),
    taskTerminalRead: vi.fn(),
    taskTerminalResize: vi.fn(),
    taskTerminalInput: vi.fn(async () => ({
      ok: true,
      value: { accepted: true },
    })),
    taskTerminalCreate: vi.fn(),
    taskTerminalAction: vi.fn(),
    taskTerminalClose: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      TaskTerminalStore,
      { provide: BackendClientService, useValue: { state: connection } },
      { provide: ELEVENEX_BRIDGE, useValue: bridge },
    ],
  });
  return { store: TestBed.inject(TaskTerminalStore), bridge, connection };
}
afterEach(() => TestBed.resetTestingModule());

function terminal(id: number): TaskTerminal {
  return {
    id, taskId: 1, title: `Shell ${id}`, cwd: "/task", branch: "work",
    generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 0,
    alive: true, status: "idle", command: "", exitCode: 0, port: null, canRerun: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function setupTerminals() {
  const state = setup();
  state.bridge.taskTerminalList.mockResolvedValue({
    ok: true,
    value: { taskId: 1, terminals: [terminal(2), terminal(3), terminal(4)], scripts: [], limit: 16 },
  });
  state.store.select({ scopeId: "scope", taskId: 1 });
  await state.store.refresh();
  return state;
}

it('sends the explicit plain-shell choice without changing ordinary launch defaults', async () => {
  const { store, bridge } = await setupTerminals();
  bridge.taskTerminalCreate.mockResolvedValue({ ok: true, value: terminal(5) });
  await store.create();
  expect(bridge.taskTerminalCreate).toHaveBeenLastCalledWith('scope', { taskId: 1 });
  await store.create(undefined, false);
  expect(bridge.taskTerminalCreate).toHaveBeenLastCalledWith('scope', { taskId: 1, shellIntegration: false });
});

describe("Immediate terminal close", () => {
  it("clears the last tab immediately without entering a loading or busy state", async () => {
    const { store, bridge } = await setupTerminals();
    bridge.taskTerminalList.mockResolvedValue({
      ok: true,
      value: { taskId: 1, terminals: [terminal(2)], scripts: [], limit: 16 },
    });
    await store.refresh();
    const cleanup = deferred<{ ok: true; value: { closed: true } }>();
    bridge.taskTerminalClose.mockReturnValue(cleanup.promise);
    const closing = store.close(2);
    expect(store.snapshot()?.terminals).toEqual([]);
    expect(store.current()).toBeNull();
    expect(store.active()).toBeNull();
    expect(store.busy()).toBe(false);
    expect(store.loading()).toBe(false);
    await store.refresh();
    expect(store.snapshot()?.terminals).toEqual([]);
    bridge.taskTerminalList.mockResolvedValue(page(1));
    cleanup.resolve({ ok: true, value: { closed: true } });
    await closing;
  });
  it("removes the selected tab immediately and allows creating another while cleanup is pending", async () => {
    const { store, bridge } = await setupTerminals();
    const cleanup = deferred<{ ok: true; value: { closed: true } }>();
    bridge.taskTerminalClose.mockReturnValue(cleanup.promise);
    store.active.set(3);
    store.markSeen(3, 10);
    const closing = store.close(3);
    expect(store.snapshot()?.terminals.map(row => row.id)).toEqual([2, 4]);
    expect(store.active()).toBe(4);
    expect(store.seen().has(3)).toBe(false);
    expect(store.busy()).toBe(false);
    await store.refresh();
    expect(store.snapshot()?.terminals.map(row => row.id)).toEqual([2, 4]);
    bridge.taskTerminalCreate.mockResolvedValue({ ok: true, value: terminal(5) });
    await store.create();
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    bridge.taskTerminalList.mockResolvedValue(page(1));
    cleanup.resolve({ ok: true, value: { closed: true } });
    await closing;
  });
  it("allows concurrent closes, deduplicates the same tab and preserves the selected remaining tab", async () => {
    const { store, bridge } = await setupTerminals();
    const cleanup = deferred<{ ok: true; value: { closed: true } }>();
    bridge.taskTerminalClose.mockReturnValue(cleanup.promise);
    const first = store.close(3);
    const second = store.close(4);
    await store.close(3);
    await store.refresh();
    expect(bridge.taskTerminalClose).toHaveBeenCalledTimes(2);
    expect(store.snapshot()?.terminals.map(row => row.id)).toEqual([2]);
    expect(store.active()).toBe(2);
    bridge.taskTerminalList.mockResolvedValue(page(1));
    cleanup.resolve({ ok: true, value: { closed: true } });
    await Promise.all([first, second]);
  });
  it("rejects a stale list that finishes after successful cleanup", async () => {
    const { store, bridge } = await setupTerminals();
    const oldList = deferred<BackendResult<TaskTerminalList>>();
    bridge.taskTerminalList.mockReturnValueOnce(oldList.promise);
    const refresh = store.refresh();
    bridge.taskTerminalClose.mockResolvedValue({ ok: true, value: { closed: true } });
    bridge.taskTerminalList.mockResolvedValue(page(1));
    await store.close(2);
    oldList.resolve({ ok: true, value: { taskId: 1, terminals: [terminal(2)], scripts: [], limit: 16 } });
    await refresh;
    expect(store.snapshot()?.terminals).toEqual([]);
    expect(store.active()).toBeNull();
  });
  it.each(["failure", "unknown", "throw"])("reconciles a %s without replaying close or replacing the person's new selection", async (outcome) => {
    const { store, bridge } = await setupTerminals();
    const cleanup = deferred<{ ok: false; error: { code: "http" | "outcome-unknown"; message: string } }>();
    bridge.taskTerminalClose.mockReturnValue(cleanup.promise);
    const closing = store.close(2);
    store.active.set(4);
    if (outcome === "throw") cleanup.reject(new Error("Disconnected"));
    else cleanup.resolve({ ok: false, error: { code: outcome === "unknown" ? "outcome-unknown" : "http", message: "Could not close terminal" } });
    await closing;
    expect(store.snapshot()?.terminals.map(row => row.id)).toEqual([2, 3, 4]);
    expect(store.active()).toBe(4);
    expect(store.busy()).toBe(false);
    expect(store.error()).toContain(outcome === "failure" ? "Could not close" : "Closing outcome is unknown");
    expect(bridge.taskTerminalClose).toHaveBeenCalledTimes(1);
  });
  it("keeps a closing tab hidden across task switches and ignores errors from the old selection", async () => {
    const { store, bridge } = await setupTerminals();
    const cleanup = deferred<{ ok: false; error: { code: "http"; message: string } }>();
    bridge.taskTerminalClose.mockReturnValue(cleanup.promise);
    const closing = store.close(2);
    store.select({ scopeId: "scope", taskId: 2 });
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    expect(store.snapshot()?.terminals.map(row => row.id)).toEqual([3, 4]);
    store.select({ scopeId: "scope", taskId: 2 });
    bridge.taskTerminalList.mockResolvedValue(page(2));
    await store.refresh();
    cleanup.resolve({ ok: false, error: { code: "http", message: "Old close failed" } });
    await closing;
    expect(store.snapshot()?.taskId).toBe(2);
    expect(store.error()).toBe("");
  });
});

describe("Task terminal selection and recovery", () => {
  it("does not spawn on selection, discards an old task read and retains the new task owner", async () => {
    const { store, bridge } = setup();
    let resolve!: (result: BackendResult<TaskTerminalList>) => void;
    bridge.taskTerminalList.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    store.select({ scopeId: "scope", taskId: 1 });
    store.select({ scopeId: "scope", taskId: 2 });
    await vi.waitFor(() => expect(store.snapshot()?.taskId).toBe(2));
    resolve(page(1));
    await Promise.resolve();
    expect(store.snapshot()?.taskId).toBe(2);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    store.select({ scopeId: "scope", taskId: 2 });
    expect(bridge.taskTerminalList).toHaveBeenCalledTimes(2);
  });
  it("rejects stale-scope keystrokes before dispatch and never launches on reconnect", async () => {
    const { store, bridge, connection } = setup();
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    connection.set({
      revision: 2,
      scope: { id: "next", environment: { kind: "local" } },
    });
    expect(
      (
        await store.input(
          { scopeId: "scope", taskId: 1 },
          2,
          "generation",
          "echo no\r",
        )
      ).ok,
    ).toBe(false);
    expect(bridge.taskTerminalInput).not.toHaveBeenCalled();
    store.select({ scopeId: "next", taskId: 1 });
    await store.refresh();
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    expect(bridge.taskTerminalAction).not.toHaveBeenCalled();
  });
  it("reconciles an uncertain create without retrying it", async () => {
    const { store, bridge } = setup();
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    bridge.taskTerminalCreate.mockResolvedValue({
      ok: false,
      error: { code: "outcome-unknown", message: "unknown" },
    });
    await store.create();
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    expect(store.error()).toContain("Startup may have completed");
    expect(bridge.taskTerminalList.mock.calls.length).toBeGreaterThan(2);
  });
  it("discards a late terminal error after switching tabs within the same task", async () => {
    const { store, bridge } = setup();
    const row: TaskTerminal = {
      id: 2,
      taskId: 1,
      title: "bash",
      cwd: "/task",
      branch: "work",
      generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 0,
      alive: true,
      status: "idle",
      command: "",
      exitCode: 0,
      port: null,
      canRerun: false,
    };
    bridge.taskTerminalList.mockResolvedValue({
      ok: true,
      value: {
        taskId: 1,
        terminals: [row, { ...row, id: 3 }],
        scripts: [],
        limit: 16,
      },
    });
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    let resolve!: (value: BackendResult<TaskTerminalOutput>) => void;
    bridge.taskTerminalRead.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = store.read(
      { scopeId: "scope", taskId: 1 },
      2,
      row.generation,
      0,
    );
    store.active.set(3);
    resolve({
      ok: false,
      error: { code: "http", status: 404, message: "Old terminal gone" },
    });
    expect(await pending).toBeNull();
    expect(store.error()).toBe("");
  });
  it("resets unread output identity when a process is explicitly replaced", async () => {
    const { store, bridge } = setup();
    const row: TaskTerminal = {
      id: 2,
      taskId: 1,
      title: "bash",
      cwd: "/task",
      branch: "work",
      generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 50,
      alive: true,
      status: "idle",
      command: "",
      exitCode: 0,
      port: null,
      canRerun: false,
    };
    bridge.taskTerminalList.mockResolvedValue({
      ok: true,
      value: { taskId: 1, terminals: [row], scripts: [], limit: 16 },
    });
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    store.markSeen(2, 50);
    bridge.taskTerminalList.mockResolvedValue({
      ok: true,
      value: {
        taskId: 1,
        terminals: [
          {
            ...row,
            generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sequence: 1,
          },
        ],
        scripts: [],
        limit: 16,
      },
    });
    await store.refresh();
    expect(store.seen().has(2)).toBe(false);
    store.markSeen(2, 1);
    expect(store.seen().get(2)).toBe(1);
    bridge.taskTerminalList.mockResolvedValue(page(1));
    await store.refresh();
    expect(store.seen().size).toBe(0);
  });
  it("clears a transient read failure on recovery while retaining mutation outcome warnings", async () => {
    const { store, bridge } = setup();
    bridge.taskTerminalList.mockResolvedValue({
      ok: false,
      error: { code: "transport", message: "Temporarily disconnected" },
    });
    store.select({ scopeId: "scope", taskId: 1 });
    await vi.waitFor(() =>
      expect(store.error()).toBe("Temporarily disconnected"),
    );
    bridge.taskTerminalList.mockResolvedValue(page(1));
    await store.refresh();
    expect(store.error()).toBe("");
  });
  it("does not confirm a failed resize so a later attachment can fit again", async () => {
    const { store, bridge } = await setupTerminals();
    bridge.taskTerminalResize.mockResolvedValue({
      ok: false,
      error: { code: "transport", message: "Resize interrupted" },
    });
    await expect(
      store.resize({ scopeId: "scope", taskId: 1 }, 2, "generation", 100, 30),
    ).rejects.toThrow("Resize interrupted");
  });
  it("rejects queued input and resize after switching tasks or tabs in the same scope", async () => {
    const { store, bridge } = await setupTerminals();
    const target = { scopeId: "scope", taskId: 1 };
    store.active.set(3);
    expect((await store.input(target, 2, "generation", "old")).ok).toBe(false);
    await expect(store.resize(target, 2, "generation", 100, 30)).rejects.toThrow("selection changed");
    store.select({ scopeId: "scope", taskId: 2 });
    store.active.set(2);
    expect((await store.input(target, 2, "generation", "old")).ok).toBe(false);
    await expect(store.resize(target, 2, "generation", 100, 30)).rejects.toThrow("selection changed");
    expect(bridge.taskTerminalInput).not.toHaveBeenCalled();
    expect(bridge.taskTerminalResize).not.toHaveBeenCalled();
  });
});
