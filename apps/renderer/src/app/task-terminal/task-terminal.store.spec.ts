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
    const { store, bridge } = setup();
    store.select({ scopeId: "scope", taskId: 1 });
    await store.refresh();
    bridge.taskTerminalResize.mockResolvedValue({
      ok: false,
      error: { code: "transport", message: "Resize interrupted" },
    });
    await expect(
      store.resize({ scopeId: "scope", taskId: 1 }, 2, "generation", 100, 30),
    ).rejects.toThrow("Resize interrupted");
  });
});
