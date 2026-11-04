import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import type {
  BackendResult,
  RepositoryReviewPage,
  RepositoryReviewSource,
  RepositoryReviewFile,
  RepositoryReviewQuery,
} from "@elevenex/shared";
import { ELEVENEX_BRIDGE } from "../backend/backend-client.service";
import type {
  ChangeFile,
  DiffFileContent,
  DiffFileRequest,
  DiffContextRequest,
  ReviewMode,
} from "../views";

import { lineCount, mergeHunks, sliceHunks } from "./repository-review-line-window";

export interface RepositoryReviewTarget {
  readonly scopeId: string;
  readonly taskId: number;
}

/** One mounted task review. Metadata and content have independent, bounded lifetimes. */
@Injectable()
export class RepositoryReviewStore {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  readonly page = signal<RepositoryReviewPage | null>(null);
  readonly files = signal<readonly ChangeFile[]>([]);
  readonly contents = signal<readonly DiffFileContent[]>([]);
  readonly selected = signal<string | undefined>(undefined);
  readonly source = signal<RepositoryReviewSource>("uncommitted");
  readonly base = signal("");
  readonly query = signal("");
  readonly mode = signal<ReviewMode>("changes");
  readonly wrap = signal(true);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly pending = signal<RepositoryReviewPage | null>(null);
  readonly refs = signal<readonly string[]>([]);
  readonly moreRefs = signal(false);
  readonly branchBusy = signal(false);
  readonly branchError = signal("");
  private target: RepositoryReviewTarget | null = null;
  private active = false;
  private defaultResolved = false;
  private choosingDefault = false;
  private sourceChosen = false;
  private readonly sourceChoices = new Map<
    number,
    { readonly source: RepositoryReviewSource; readonly base: string }
  >();
  private offline = false;
  private filterPending = false;
  private epoch = 0;
  private contentEpoch = 0;
  private branchEpoch = 0;
  private branchRequest?: { readonly scope: string; readonly id: string };
  private timer?: ReturnType<typeof setTimeout>;
  private filterTimer?: ReturnType<typeof setTimeout>;
  private readonly requests = new Map<string, string>();
  private queue: DiffFileRequest[] = [];
  private inFlight = new Set<string>();
  private readonly offsets = new Map<string, number>();
  private readonly nextOffsets = new Map<string, number>();
  private readonly windowEnds = new Map<string, number>();
  private readonly contexts = new Map<
    string,
    NonNullable<RepositoryReviewQuery["expansions"]>
  >();
  private readonly forced = new Set<string>();
  private readonly selections = new Map<string, string>();
  private lastPath?: string;
  private selectionKey(): string {
    return `${this.source()}:${this.base()}`;
  }
  private rememberSelection(): void {
    const selected = this.selected();
    if (selected) this.selections.set(this.selectionKey(), selected);
    this.lastPath = this.files().find((file) => file.id === selected)?.path;
    while (this.selections.size > 32) {
      const first = this.selections.keys().next().value;
      if (first) this.selections.delete(first);
    }
  }
  private readonly viewedRevisions = new Map<string, string>();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  connect(
    target: RepositoryReviewTarget | null,
    active: boolean,
    offline: boolean,
  ): void {
    const changed =
      target?.taskId !== this.target?.taskId ||
      target?.scopeId !== this.target?.scopeId;
    const resumed = active && (!this.active || (this.offline && !offline));
    this.active = active;
    this.offline = offline;
    if (changed) {
      const sameTask = target?.taskId === this.target?.taskId;
      this.stop();
      this.target = target;
      if (!sameTask) {
        this.page.set(null);
        this.files.set([]);
        this.contents.set([]);
        this.pending.set(null);
        this.selected.set(undefined);
        const choice = target
          ? this.sourceChoices.get(target.taskId)
          : undefined;
        this.sourceChosen = !!choice;
        this.defaultResolved = !!choice;
        this.source.set(choice?.source ?? "uncommitted");
        this.base.set(choice?.base ?? "");
        this.query.set("");
        this.viewedRevisions.clear();
        this.selections.clear();
        this.lastPath = undefined;
        this.refs.set([]);
      }
    }
    if (!active || offline) {
      this.stop();
      return;
    }
    if (target && (changed || resumed || !this.page()))
      void this.load(!!this.page());
  }
  private stop(): void {
    this.epoch++;
    this.contentEpoch++;
    this.branchEpoch++;
    clearTimeout(this.timer);
    clearTimeout(this.filterTimer);
    for (const [id, scope] of this.requests)
      void this.bridge.repositoryReviewCancel(scope, id).catch(() => undefined);
    this.contents.update((contents) =>
      contents.map((content) =>
        content.state === "loading" || content.loading
          ? {
              ...content,
              loading: false,
              state: content.state === "ready" ? "ready" : "error",
              error:
                "Loading was interrupted. Try again when the task is available.",
            }
          : content,
      ),
    );
    this.requests.clear();
    this.queue = [];
    this.inFlight.clear();
    this.busy.set(false);
    this.choosingDefault = false;
    this.branchBusy.set(false);
  }
  private rememberSource(source = this.source()): void {
    this.sourceChosen = true;
    this.defaultResolved = true;
    if (!this.target) return;
    this.sourceChoices.delete(this.target.taskId);
    this.sourceChoices.set(this.target.taskId, { source, base: this.base() });
    while (this.sourceChoices.size > 20) {
      const oldest = this.sourceChoices.keys().next().value;
      if (oldest !== undefined) this.sourceChoices.delete(oldest);
    }
  }
  setSource(source: RepositoryReviewSource): void {
    const wasChoosing = this.choosingDefault;
    this.rememberSource(source);
    if (source === this.source()) {
      if (wasChoosing) {
        this.stop();
        void this.load();
      }
      return;
    }
    this.rememberSelection();
    this.stop();
    this.source.set(source);
    this.mode.set("changes");
    this.query.set("");
    this.resetReview();
    void this.load();
  }
  setBase(ref: string): void {
    this.rememberSelection();
    this.stop();
    this.base.set(ref);
    this.rememberSource();
    this.resetReview();
    void this.load();
  }
  private resetReview(): void {
    this.page.set(null);
    this.files.set([]);
    this.contents.set([]);
    this.pending.set(null);
    this.selected.set(undefined);
    this.offsets.clear();
    this.contexts.clear();
    this.nextOffsets.clear();
    this.windowEnds.clear();
    this.forced.clear();
  }
  filter(value: string): void {
    this.query.set(value);
    clearTimeout(this.filterTimer);
    this.pending.set(null);
    this.filterTimer = setTimeout(() => {
      if (this.busy()) this.filterPending = true;
      else void this.load(false, 0, true);
    }, 180);
  }
  pageFiles(direction: -1 | 1): void {
    const page = this.page();
    if (!page) return;
    void this.load(
      false,
      direction < 0
        ? Math.max(0, page.offset - 100)
        : (page.nextOffset ?? page.offset),
      true,
    );
  }
  async load(
    background = false,
    offset = this.page()?.offset ?? 0,
    pinned = false,
  ): Promise<void> {
    const target = this.target;
    if (!target || !this.active || this.offline || this.busy()) return;
    clearTimeout(this.timer);
    const epoch = this.epoch,
      source = this.source(),
      base = this.base(),
      query = this.query(),
      requestId = crypto.randomUUID();
    const chooseDefault =
      !this.defaultResolved &&
      !this.sourceChosen &&
      !pinned &&
      (!background || !this.page());
    const requestedSource = chooseDefault ? "uncommitted" : source;
    this.choosingDefault = chooseDefault;
    this.busy.set(true);
    if (!background) this.error.set("");
    this.requests.set(requestId, target.scopeId);
    try {
      const reply = await this.bridge.repositoryReview(target.scopeId, {
        taskId: target.taskId,
        requestId,
        source: requestedSource,
        ...(requestedSource === "branch" && base ? { baseRef: base } : {}),
        query,
        offset: chooseDefault ? 0 : offset,
        ...(pinned && this.page() ? { revision: this.page()!.revision } : {}),
      });
      if (
        epoch !== this.epoch ||
        source !== this.source() ||
        base !== this.base() ||
        query !== this.query()
      )
        return;
      if (!reply.ok) {
        this.error.set(reply.error.message);
        return;
      }
      if (
        reply.value.taskId !== target.taskId ||
        reply.value.source !== requestedSource
      ) {
        this.error.set(
          "The review reply did not match the selected task. Try again.",
        );
        return;
      }
      let nextPage = reply.value;
      if (chooseDefault && !this.sourceChosen) {
        // A zero-row filtered page is not a clean workspace: use the authoritative
        // total, including staged, unstaged and untracked entries across all pages.
        if (
          requestedSource === "uncommitted" &&
          nextPage.total === 0 &&
          nextPage.headSha
        ) {
          const lastRequestId = crypto.randomUUID();
          this.requests.set(lastRequestId, target.scopeId);
          let last: BackendResult<RepositoryReviewPage>;
          try {
            last = await this.bridge.repositoryReview(target.scopeId, {
              taskId: target.taskId,
              requestId: lastRequestId,
              source: "last-commit",
              query,
              offset: source === "last-commit" ? offset : 0,
            });
          } finally {
            this.requests.delete(lastRequestId);
          }
          if (
            epoch !== this.epoch ||
            this.sourceChosen ||
            source !== this.source()
          )
            return;
          if (
            !last.ok ||
            last.value.taskId !== target.taskId ||
            last.value.source !== "last-commit"
          ) {
            if (!this.page()) this.accept(nextPage);
            this.error.set(
              last.ok
                ? "The review reply did not match the selected task. Try again."
                : last.error.message,
            );
            return;
          }
          // A concurrent commit must not combine an old clean check with a newer
          // HEAD. Stay with the coherent first snapshot and reconcile on refresh.
          if (last.value.headSha === nextPage.headSha) nextPage = last.value;
        }
        this.defaultResolved = true;
        if (nextPage.source !== this.source()) {
          this.rememberSelection();
          this.cancelContent();
        }
        this.source.set(nextPage.source);
      }
      // Keep the current bounded file window when the source remains the same;
      // clamp removed tails rather than leaving an unreachable empty page.
      const availableOffset = Math.max(
        0,
        Math.floor((nextPage.matched - 1) / 100) * 100,
      );
      const desiredOffset =
        nextPage.source === source ? Math.min(offset, availableOffset) : 0;
      if (nextPage.offset !== desiredOffset) {
        const pageRequestId = crypto.randomUUID();
        this.requests.set(pageRequestId, target.scopeId);
        let window: BackendResult<RepositoryReviewPage>;
        try {
          window = await this.bridge.repositoryReview(target.scopeId, {
            taskId: target.taskId,
            requestId: pageRequestId,
            source: nextPage.source,
            revision: nextPage.revision,
            query,
            offset: desiredOffset,
          });
        } finally {
          this.requests.delete(pageRequestId);
        }
        if (epoch !== this.epoch || query !== this.query()) return;
        if (
          !window.ok ||
          window.value.taskId !== target.taskId ||
          window.value.source !== nextPage.source ||
          window.value.revision !== nextPage.revision ||
          window.value.offset !== desiredOffset
        ) {
          this.error.set(
            window.ok
              ? "The review window changed. Refresh to try again."
              : window.error.message,
          );
          return;
        }
        nextPage = window.value;
      }
      if (background && this.page()) {
        if (nextPage.revision !== this.page()!.revision)
          this.pending.set(nextPage);
      } else this.accept(nextPage);
    } catch {
      if (epoch === this.epoch)
        this.error.set("Repository changes could not be loaded. Try again.");
    } finally {
      this.requests.delete(requestId);
      if (epoch === this.epoch) {
        this.choosingDefault = false;
        this.busy.set(false);
        if (this.filterPending) {
          this.filterPending = false;
          void this.load(false, 0, true);
        } else this.schedule();
      }
    }
  }
  refresh(): void {
    if (this.busy()) return;
    if (!this.sourceChosen) {
      this.defaultResolved = false;
      this.pending.set(null);
      void this.load(false);
      return;
    }
    const pending = this.pending();
    if (pending && pending.offset === (this.page()?.offset ?? 0)) {
      this.accept(pending);
      this.pending.set(null);
    } else {
      this.pending.set(null);
      void this.load();
    }
  }
  private accept(page: RepositoryReviewPage): void {
    const before = this.files();
    const files = page.files.map((file): ChangeFile => {
      const viewed = this.viewedRevisions.get(file.id);
      return {
        ...file,
        repository: layerLabel(file.layer),
        layerLabel:
          file.layer === "committed" ? undefined : layerLabel(file.layer),
        detail:
          file.status !== "A" &&
          file.status !== "D" &&
          file.oldMode !== file.newMode
            ? `${layerLabel(file.layer)} · mode ${file.oldMode} → ${file.newMode}`
            : undefined,
        viewed: viewed === file.rev,
        changedSinceViewed: !!viewed && viewed !== file.rev,
        countsExact: file.countsExact,
      };
    });
    this.page.set(page);
    this.files.set(files);
    this.error.set("");
    const revisions = new Map(files.map((file) => [file.id, file.rev]));
    for (const id of this.offsets.keys())
      if (!revisions.has(id)) {
        this.offsets.delete(id);
        this.nextOffsets.delete(id);
        this.windowEnds.delete(id);
        this.contexts.delete(id);
        this.forced.delete(id);
      }
    this.queue = this.queue.filter(
      (request) =>
        revisions.get(request.fileId) === request.rev &&
        request.mode === this.mode(),
    );
    this.contents.update((contents) =>
      contents.filter(
        (content) => revisions.get(content.fileId) === content.rev,
      ),
    );
    for (const file of files)
      if (before.find((item) => item.id === file.id)?.rev !== file.rev) {
        this.offsets.delete(file.id);
        this.contexts.delete(file.id);
        this.nextOffsets.delete(file.id);
        this.windowEnds.delete(file.id);
        this.forced.delete(file.id);
      }
    if (!files.some((file) => file.id === this.selected()))
      this.selected.set(
        files.find(
          (file) => file.id === this.selections.get(this.selectionKey()),
        )?.id ??
          files.find((file) => file.path === this.lastPath)?.id ??
          files[0]?.id,
      );
    // A refresh with unchanged file revisions leaves Viewed and reading anchors intact.
  }
  setMode(mode: ReviewMode): void {
    this.cancelContent();
    this.mode.set(mode);
    this.offsets.clear();
    this.nextOffsets.clear();
    this.windowEnds.clear();
    this.contents.update((contents) =>
      contents.filter(
        (content) => content.mode === mode && content.state === "ready",
      ),
    );
  }
  viewed(intent: {
    fileId: string;
    rev?: string | number;
    viewed: boolean;
  }): void {
    if (
      typeof intent.rev !== "string" ||
      !this.files().some(
        (file) => file.id === intent.fileId && file.rev === intent.rev,
      )
    )
      return;
    if (intent.viewed) this.viewedRevisions.set(intent.fileId, intent.rev);
    else this.viewedRevisions.delete(intent.fileId);
    while (this.viewedRevisions.size > 5000) {
      const key = this.viewedRevisions.keys().next().value;
      if (key) this.viewedRevisions.delete(key);
    }
    this.files.update((files) =>
      files.map((file) =>
        file.id === intent.fileId
          ? { ...file, viewed: intent.viewed, changedSinceViewed: false }
          : file,
      ),
    );
  }
  context(request: DiffContextRequest): void {
    if (!this.matches(request) || this.inFlight.has(request.fileId)) return;
    const expansions = this.contexts.get(request.fileId) ?? [];
    const previous = expansions.find(
      (item) => item.hunkId === request.hunkId,
    ) ?? { hunkId: request.hunkId, before: 0, after: 0 };
    const updated = {
      ...previous,
      [request.direction]: Math.min(
        200,
        previous[request.direction] + Math.min(20, request.count),
      ),
    };
    this.contexts.set(request.fileId, [
      ...expansions.filter((item) => item.hunkId !== request.hunkId).slice(-31),
      updated,
    ]);
    this.request({ ...request, reason: "context" });
  }
  request(request: DiffFileRequest): void {
    if (
      !this.matches(request) ||
      !this.active ||
      this.offline ||
      this.queue.some((item) => item.fileId === request.fileId)
    )
      return;
    if (request.reason === "large" || request.reason === "deleted")
      this.forced.add(request.fileId);
    if (request.reason === "visible" || request.reason === "selected") {
      if (
        this.contents().some(
          (content) =>
            content.fileId === request.fileId &&
            content.rev === request.rev &&
            content.mode === request.mode &&
            content.state === "ready",
        )
      )
        return;
    }
    if (this.inFlight.has(request.fileId)) return;
    this.queue.push(request);
    this.pump();
  }
  private matches(request: {
    fileId: string;
    rev?: string | number;
    mode: ReviewMode;
  }): boolean {
    return (
      request.mode === this.mode() &&
      this.files().some(
        (file) => file.id === request.fileId && file.rev === request.rev,
      )
    );
  }
  private cancelContent(): void {
    this.contentEpoch++;
    this.queue = [];
    this.inFlight.clear();
    for (const [id, scope] of this.requests)
      if (id.startsWith("file-")) {
        void this.bridge
          .repositoryReviewCancel(scope, id)
          .catch(() => undefined);
        this.requests.delete(id);
      }
  }
  private pump(): void {
    while (this.inFlight.size < 3 && this.queue.length) {
      const next = this.queue.findIndex(
        (request) => !this.inFlight.has(request.fileId),
      );
      if (next < 0) return;
      const request = this.queue.splice(next, 1)[0];
      if (request) void this.readFile(request);
    }
  }
  private put(content: DiffFileContent): void {
    this.contents.update((contents) => [
      ...contents
        .filter(
          (item) =>
            !(item.fileId === content.fileId && item.mode === content.mode),
        )
        .slice(-99),
      content,
    ]);
  }
  private async readFile(request: DiffFileRequest): Promise<void> {
    const target = this.target,
      page = this.page();
    if (!target || !page) return;
    const epoch = this.contentEpoch,
      requestId = "file-" + crypto.randomUUID();
    const previous = this.contents().find(
      (content) =>
        content.fileId === request.fileId &&
        content.rev === request.rev &&
        content.mode === request.mode &&
        content.state === "ready",
    );
    const offset =
      request.reason === "more"
        ? (this.nextOffsets.get(request.fileId) ?? 0)
        : request.reason === "previous"
          ? Math.max(0, (this.offsets.get(request.fileId) ?? 0) - 400)
          : (this.offsets.get(request.fileId) ?? 0);
    this.inFlight.add(request.fileId);
    this.requests.set(requestId, target.scopeId);
    this.put(
      previous
        ? { ...previous, loading: true, error: undefined }
        : {
            fileId: request.fileId,
            rev: request.rev,
            mode: request.mode,
            state: "loading",
          },
    );
    const input: RepositoryReviewQuery = {
      taskId: target.taskId,
      requestId,
      source: this.source(),
      revision: page.revision,
      fileId: request.fileId,
      fileRev: String(request.rev),
      mode: request.mode,
      lineOffset: offset,
      expansions: this.contexts.get(request.fileId) ?? [],
      force: this.forced.has(request.fileId),
    };
    try {
      const result = await this.bridge.repositoryReview(target.scopeId, input);
      if (epoch !== this.contentEpoch || !this.matches(request)) return;
      if (!result.ok) {
        this.put(
          previous
            ? { ...previous, loading: false, error: result.error.message }
            : { ...request, state: "error", error: result.error.message },
        );
        return;
      }
      let content = result.value.content;
      if (
        !content ||
        content.fileId !== request.fileId ||
        content.rev !== request.rev ||
        content.mode !== request.mode ||
        result.value.revision !== page.revision ||
        content.offset !== offset ||
        result.value.taskId !== target.taskId
      )
        throw new Error("Mismatched file page.");
      // Context changes the flattened offsets. Re-read the retained range in
      // bounded pages, publishing it atomically so the reading line never vanishes.
      const retainedEnd = this.windowEnds.get(request.fileId) ?? 0;
      let pagesRead = 1;
      if (
        previous &&
        (request.reason === "context" || request.reason === "retry")
      ) {
        const desiredEnd = Math.min(
          offset + 1200,
          retainedEnd + (request.reason === "context" ? 20 : 0),
        );
        while (
          pagesRead < 3 &&
          content.nextOffset !== null &&
          content.nextOffset < desiredEnd
        ) {
          pagesRead++;
          const next = await this.bridge.repositoryReview(target.scopeId, {
            ...input,
            lineOffset: content.nextOffset,
          });
          if (epoch !== this.contentEpoch || !this.matches(request)) return;
          if (!next.ok)
            throw new Error("Additional context could not be loaded.");
          const part = next.value.content;
          if (
            !part ||
            part.fileId !== request.fileId ||
            part.rev !== request.rev ||
            part.mode !== request.mode ||
            next.value.revision !== page.revision ||
            part.offset !== content.nextOffset
          )
            throw new Error("Mismatched context page.");
          content = {
            ...content,
            nextOffset: part.nextOffset,
            hunks: mergeHunks(content.hunks, part.hunks),
          };
        }
      }
      const oldOffset = this.offsets.get(request.fileId) ?? 0;
      let start = offset;
      let hunks = content.hunks;
      let nextOffset = content.nextOffset;
      if (
        previous?.hunks &&
        request.reason === "more" &&
        offset === this.nextOffsets.get(request.fileId)
      ) {
        start = oldOffset;
        hunks = mergeHunks(previous.hunks, hunks);
      } else if (
        previous?.hunks &&
        request.reason === "previous" &&
        offset <= oldOffset &&
        offset + lineCount(hunks) >= oldOffset
      ) {
        // A short final page can move the window off a 400-line boundary.
        // Prepend only its unseen prefix when the earlier wire page overlaps.
        hunks = mergeHunks(sliceHunks(hunks, 0, oldOffset - offset), previous.hunks);
        nextOffset = this.nextOffsets.get(request.fileId) ?? null;
      }
      // Keep three wire pages near the reader. Earlier/later text remains reachable.
      const count = lineCount(hunks);
      const trimStart =
        request.reason === "more" ? Math.max(0, count - 1200) : 0;
      const kept = sliceHunks(hunks, trimStart, trimStart + 1200);
      start += trimStart;
      if (request.reason !== "more" && count > 1200)
        nextOffset = start + lineCount(kept);
      this.offsets.set(request.fileId, start);
      this.windowEnds.set(request.fileId, start + lineCount(kept));
      if (nextOffset !== null) this.nextOffsets.set(request.fileId, nextOffset);
      else this.nextOffsets.delete(request.fileId);
      this.put({
        fileId: content.fileId,
        rev: content.rev,
        mode: content.mode,
        state: "ready",
        hunks: kept,
        notice: content.notice,
        hasPreviousLines: start > 0,
        hasMoreLines: nextOffset !== null,
        windowed: true,
      });
    } catch {
      if (epoch === this.contentEpoch)
        this.put({
          ...(previous ?? request),
          state: previous ? "ready" : "error",
          loading: false,
          error: "This file could not be loaded. Try again.",
        });
    } finally {
      this.requests.delete(requestId);
      if (epoch === this.contentEpoch) {
        this.inFlight.delete(request.fileId);
        this.pump();
      }
    }
  }
  async searchBranches(query: string): Promise<void> {
    const target = this.target;
    if (!target || this.offline) return;
    if (this.branchRequest)
      void this.bridge
        .repositoryReviewCancel(this.branchRequest.scope, this.branchRequest.id)
        .catch(() => undefined);
    const epoch = ++this.branchEpoch,
      requestId = crypto.randomUUID();
    this.requests.set(requestId, target.scopeId);
    this.branchRequest = { scope: target.scopeId, id: requestId };
    this.branchBusy.set(true);
    this.branchError.set("");
    try {
      const result = await this.bridge.repositoryReviewBranches(
        target.scopeId,
        { taskId: target.taskId, requestId, query },
      );
      if (epoch !== this.branchEpoch) return;
      if (result.ok) {
        this.refs.set(result.value.refs);
        this.moreRefs.set(result.value.hasMore);
      } else this.branchError.set(result.error.message);
    } catch {
      if (epoch === this.branchEpoch)
        this.branchError.set("Branches could not be loaded. Try again.");
    } finally {
      this.requests.delete(requestId);
      if (epoch === this.branchEpoch) this.branchBusy.set(false);
    }
  }
  file(id: string): RepositoryReviewFile | undefined {
    return this.page()?.files.find((file) => file.id === id);
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.active && !this.offline)
      this.timer = setTimeout(() => {
        if (!document.hidden) void this.load(true);
        else this.schedule();
      }, 10000);
  }
}
const layerLabel = (layer: RepositoryReviewFile["layer"]): string =>
  ({
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
    committed: "Committed",
  })[layer];
