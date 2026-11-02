import { TestBed } from "@angular/core/testing";
import type {
  BackendResult,
  ElevenexBridge,
  RepositoryReviewPage,
  RepositoryReviewQuery,
} from "@elevenex/shared";
import { ELEVENEX_BRIDGE } from "../backend/backend-client.service";
import { RepositoryReviewStore } from "./repository-review.store";

const scope = "11111111-1111-1111-1111-111111111111";
const rev = "a".repeat(64);
function page(taskId = 1, revision = rev): RepositoryReviewPage {
  return {
    taskId,
    source: "uncommitted",
    revision,
    headSha: "a".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: null,
    targetSha: null,
    fingerprint: rev,
    explanation: "Staged and unstaged",
    total: 5,
    matched: 5,
    additions: 5,
    deletions: 0,
    countsExact: true,
    offset: 0,
    nextOffset: null,
    files: Array.from({ length: 5 }, (_, index) => ({
      id: `unstaged:file-${index}`,
      path: `file-${index}`,
      rev,
      layer: "unstaged",
      status: "M",
      add: 1,
      del: 0,
      binary: false,
      large: false,
      countsExact: true,
      oldRevision: "a".repeat(40),
      newRevision: "b".repeat(40),
      oldMode: "100644",
      newMode: "100644",
    })),
    content: null,
  };
}
const success = (
  value: RepositoryReviewPage,
): BackendResult<RepositoryReviewPage> => ({ ok: true, value });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("task-owned repository review requests", () => {
  let bridge: Pick<
    ElevenexBridge,
    "repositoryReview" | "repositoryReviewCancel" | "repositoryReviewBranches"
  >;
  let store: RepositoryReviewStore;
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = {
      repositoryReview: vi.fn(async () => success(page())),
      repositoryReviewCancel: vi.fn(async () => undefined),
      repositoryReviewBranches: vi.fn(async () => ({
        ok: true as const,
        value: { taskId: 1, refs: [], hasMore: false },
      })),
    };
    TestBed.configureTestingModule({
      providers: [
        RepositoryReviewStore,
        { provide: ELEVENEX_BRIDGE, useValue: bridge },
      ],
    });
    store = TestBed.inject(RepositoryReviewStore);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  it("rejects late task/scope replies and cancels its owned requests", async () => {
    const first = deferred<BackendResult<RepositoryReviewPage>>();
    vi.mocked(bridge.repositoryReview).mockReturnValueOnce(first.promise);
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    store.connect({ scopeId: scope, taskId: 2 }, true, false);
    await flush();
    first.resolve(success(page(1)));
    await flush();
    expect(bridge.repositoryReviewCancel).toHaveBeenCalled();
    expect(store.page()?.taskId).not.toBe(1);
  });
  it("limits content to three requests and rejects stale mode replies", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    const pending = deferred<BackendResult<RepositoryReviewPage>>();
    vi.mocked(bridge.repositoryReview).mockImplementation(
      () => pending.promise,
    );
    for (const file of store.files())
      store.request({
        fileId: file.id,
        rev: file.rev,
        mode: "changes",
        reason: "visible",
      });
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(4);
    store.setMode("full");
    pending.resolve(
      success({
        ...page(),
        content: {
          fileId: "unstaged:file-0",
          rev,
          mode: "changes",
          offset: 0,
          nextOffset: null,
          hunks: [],
        },
      }),
    );
    await flush();
    expect(
      store
        .contents()
        .some(
          (content) => content.mode === "changes" && content.state === "ready",
        ),
    ).toBe(false);
  });
  it("offers moving revisions without replacing reading data, invalidates only changed Viewed files", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.viewed({ fileId: "unstaged:file-0", rev, viewed: true });
    store.viewed({ fileId: "unstaged:file-1", rev, viewed: true });
    store.selected.set("unstaged:file-1");
    const updated = {
      ...page(1, "b".repeat(64)),
      files: page().files.map((file, index) =>
        index ? file : { ...file, rev: "b".repeat(64) },
      ),
    };
    vi.mocked(bridge.repositoryReview).mockResolvedValue(success(updated));
    await store.load(true);
    expect(store.page()?.revision).toBe(rev);
    expect(store.pending()?.revision).toBe(updated.revision);
    store.refresh();
    await flush();
    expect(store.files()[0]!.viewed).toBe(false);
    expect(store.files()[0]!.changedSinceViewed).toBe(true);
    expect(store.files()[1]!.viewed).toBe(true);
    expect(store.selected()).toBe("unstaged:file-1");
  });
  it("retains snapshots on disconnect, reconciles on recovery and stops polling when hidden", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.connect({ scopeId: scope, taskId: 1 }, true, true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(1);
    expect(store.page()).not.toBeNull();
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(2);
    store.connect({ scopeId: scope, taskId: 1 }, false, false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(2);
  });
  it("debounces server search over the pinned snapshot and keeps errors retryable", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.filter("one");
    store.filter("two");
    await vi.advanceTimersByTimeAsync(180);
    expect(
      vi.mocked(bridge.repositoryReview).mock.calls.at(-1)?.[1],
    ).toMatchObject({ query: "two", revision: rev, offset: 0 });
    vi.mocked(bridge.repositoryReview).mockResolvedValueOnce({
      ok: false,
      error: { code: "transport", message: "Disconnected" },
    });
    await store.load();
    expect(store.error()).toBe("Disconnected");
    expect(store.page()).not.toBeNull();
    await store.load();
    expect(store.error()).toBe("");
  });
  it("coalesces duplicate file reads and preserves all exact request identities", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    const pending = deferred<BackendResult<RepositoryReviewPage>>();
    vi.mocked(bridge.repositoryReview).mockReturnValue(pending.promise);
    const request = {
      fileId: "unstaged:file-0",
      rev,
      mode: "changes" as const,
      reason: "visible" as const,
    };
    store.request(request);
    store.request(request);
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(2);
    const input: RepositoryReviewQuery = vi.mocked(bridge.repositoryReview).mock
      .calls[1]![1];
    expect(input).toMatchObject({
      taskId: 1,
      revision: rev,
      fileId: request.fileId,
      fileRev: rev,
      mode: "changes",
      lineOffset: 0,
    });
  });
  it("retains Viewed and selection when returning to an unchanged comparison", async () => {
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, query) =>
        success({
          ...page(query.taskId),
          source: query.source,
          files:
            query.source === "uncommitted"
              ? page().files
              : page().files.map((file) => ({
                  ...file,
                  id: file.id.replace("unstaged:", "committed:"),
                  layer: "committed",
                })),
        }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.selected.set("unstaged:file-1");
    store.viewed({ fileId: "unstaged:file-0", rev, viewed: true });
    store.setSource("last-commit");
    await flush();
    store.setSource("uncommitted");
    await flush();
    expect(store.files()[0]?.viewed).toBe(true);
    expect(store.selected()).toBe("unstaged:file-1");
  });
  it("automatically prefers any uncommitted entry without reading other sources", async () => {
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("uncommitted");
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(1);
  });
  it("automatically chooses Last commit for a clean repository with HEAD", async () => {
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        success(
          input.source === "uncommitted"
            ? { ...page(), files: [], total: 0, matched: 0 }
            : { ...page(), source: "last-commit" },
        ),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("last-commit");
    expect(store.page()?.source).toBe("last-commit");
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(2);
  });
  it("keeps an unborn repository on Uncommitted without requesting nonexistent history", async () => {
    vi.mocked(bridge.repositoryReview).mockResolvedValue(
      success({ ...page(), headSha: null, files: [], total: 0, matched: 0 }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("uncommitted");
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(1);
  });
  it("uses the full uncommitted total rather than a filtered or paged row count", async () => {
    vi.mocked(bridge.repositoryReview).mockResolvedValue(
      success({ ...page(), files: [], matched: 0, total: 5000 }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("uncommitted");
    expect(bridge.repositoryReview).toHaveBeenCalledTimes(1);
  });
  it("honors an explicit Uncommitted choice during the automatic Last commit read", async () => {
    const last = deferred<BackendResult<RepositoryReviewPage>>();
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        input.source === "last-commit"
          ? last.promise
          : success({ ...page(), files: [], total: 0, matched: 0 }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.setSource("uncommitted");
    await flush();
    last.resolve(success({ ...page(), source: "last-commit" }));
    await flush();
    expect(store.source()).toBe("uncommitted");
    expect(store.page()?.source).toBe("uncommitted");
    expect(bridge.repositoryReviewCancel).toHaveBeenCalled();
  });
  it("remembers manual per-task sources and excludes branch bases from other source requests", async () => {
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        success({ ...page(input.taskId), source: input.source }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.setSource("branch");
    await flush();
    store.setBase("refs/heads/release");
    await flush();
    store.setSource("uncommitted");
    await flush();
    expect(
      vi.mocked(bridge.repositoryReview).mock.calls.at(-1)?.[1].baseRef,
    ).toBeUndefined();
    store.setSource("last-commit");
    await flush();
    store.connect({ scopeId: scope, taskId: 2 }, true, false);
    await flush();
    expect(store.source()).toBe("uncommitted");
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("last-commit");
  });
  it("rejects an automatic fallback for a task that changed while it was loading", async () => {
    const last = deferred<BackendResult<RepositoryReviewPage>>();
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        input.taskId === 1 && input.source === "last-commit"
          ? last.promise
          : success(
              input.taskId === 1
                ? { ...page(1), files: [], total: 0, matched: 0 }
                : page(2),
            ),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.connect({ scopeId: scope, taskId: 2 }, true, false);
    await flush();
    last.resolve(success({ ...page(1), source: "last-commit" }));
    await flush();
    expect(store.page()?.taskId).toBe(2);
    expect(store.source()).toBe("uncommitted");
  });
  it("keeps source and snapshot coherent after a failed automatic fallback until an explicit retry", async () => {
    let failLast = true;
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        input.source === "uncommitted"
          ? success({ ...page(), files: [], total: 0, matched: 0 })
          : failLast
            ? {
                ok: false,
                error: {
                  code: "transport",
                  message: "Last commit could not be read",
                },
              }
            : success({ ...page(), source: "last-commit" }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.error()).toContain("Last commit");
    expect(store.page()?.source).toBe("uncommitted");
    failLast = false;
    await store.load(true);
    expect(store.source()).toBe(store.page()?.source);
    expect(store.source()).toBe("uncommitted");
    await store.load();
    expect(store.source()).toBe("last-commit");
    expect(store.page()?.source).toBe("last-commit");
  });
  it("reconsiders automatic sources on explicit refresh, but never on background reads", async () => {
    let dirty = false;
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        success(
          input.source === "uncommitted"
            ? dirty
              ? page()
              : { ...page(), files: [], total: 0, matched: 0 }
            : { ...page(), source: "last-commit" },
        ),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("last-commit");
    dirty = true;
    await store.load(true);
    expect(store.source()).toBe("last-commit");
    store.refresh();
    await flush();
    expect(store.source()).toBe("uncommitted");
    expect(store.page()?.total).toBe(5);
    dirty = false;
    await store.load(true);
    expect(store.source()).toBe("uncommitted");
    store.refresh();
    await flush();
    expect(store.source()).toBe("last-commit");
  });
  it("retains a coherent existing Last commit snapshot when automatic refresh cannot read its fallback", async () => {
    let failLast = false;
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        input.source === "uncommitted"
          ? success({ ...page(), files: [], total: 0, matched: 0 })
          : failLast
            ? {
                ok: false,
                error: {
                  code: "transport",
                  message: "Last commit unavailable",
                },
              }
            : success({ ...page(), source: "last-commit" }),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    expect(store.source()).toBe("last-commit");
    failLast = true;
    store.refresh();
    await flush();
    expect(store.error()).toContain("Last commit unavailable");
    expect(store.source()).toBe("last-commit");
    expect(store.page()?.source).toBe("last-commit");
  });
  it("keeps a current file filter when refreshing an automatic Last commit source", async () => {
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) =>
        success(
          input.source === "uncommitted"
            ? { ...page(), files: [], matched: 0, total: 0 }
            : { ...page(), source: "last-commit" },
        ),
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.filter("needle");
    await vi.advanceTimersByTimeAsync(180);
    store.refresh();
    await flush();
    expect(
      vi.mocked(bridge.repositoryReview).mock.calls.at(-1)?.[1],
    ).toMatchObject({ source: "last-commit", query: "needle" });
    expect(store.query()).toBe("needle");
  });
  it("preserves a bounded file page, selection and Viewed state during an automatic refresh", async () => {
    vi.mocked(bridge.repositoryReview).mockImplementation(
      async (_scope, input) => {
        const offset = input.offset ?? 0;
        return success({
          ...page(),
          offset,
          total: 500,
          matched: 500,
          nextOffset: offset + 100 < 500 ? offset + 100 : null,
          files: Array.from({ length: 100 }, (_, index) => ({
            ...page().files[0]!,
            id: `unstaged:file-${offset + index}`,
            path: `file-${offset + index}`,
          })),
        });
      },
    );
    store.connect({ scopeId: scope, taskId: 1 }, true, false);
    await flush();
    store.pageFiles(1);
    await flush();
    store.selected.set("unstaged:file-102");
    store.viewed({ fileId: "unstaged:file-102", rev, viewed: true });
    store.refresh();
    await flush();
    expect(store.page()?.offset).toBe(100);
    expect(store.selected()).toBe("unstaged:file-102");
    expect(
      store.files().find((file) => file.id === "unstaged:file-102")?.viewed,
    ).toBe(true);
    expect(
      vi.mocked(bridge.repositoryReview).mock.calls.at(-1)?.[1],
    ).toMatchObject({ offset: 100, revision: rev });
  });
});
