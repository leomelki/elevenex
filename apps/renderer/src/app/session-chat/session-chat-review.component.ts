import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { SessionChatChangesPage, SessionChatChangeSource } from "@elevenex/shared";
import { SessionChatClient } from "../backend/session-chat-client.service";
import { OpensWhenBackComponent } from '../machines';
import { ButtonComponent, DropdownComponent } from "../ui";
import {
  DiffReviewComponent,
  type ChangeFile,
  type DiffFileContent,
  type DiffFileRequest,
  type DiffLine,
} from "../views";
import type { ChatSelection } from "./session-chat.store";

export type ChatReviewTarget = ChatSelection & {
  readonly turnId: string;
  readonly path?: string;
};

/** One selected reply, with bounded file/content windows and owned cancellation. */
@Component({
  selector: "ex-session-chat-review",
  imports: [DiffReviewComponent, ButtonComponent, DropdownComponent, OpensWhenBackComponent],
  templateUrl: "./session-chat-review.component.html",
  styleUrl: "./session-chat-review.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionChatReviewComponent {
  readonly target = input.required<ChatReviewTarget>();
  readonly wide = input(false);
  readonly unreachable = input<string>();
  readonly reconnectRequested = output<void>();
  readonly wideChange = output<boolean>();
  readonly exitRequested = output<void>();
  readonly openFileRequested = output<string>();
  protected readonly source = signal<SessionChatChangeSource>("net");
  private readonly sources = signal<NonNullable<SessionChatChangesPage["sources"]>>([]);
  protected readonly sourceOptions = computed(() => [
    { id: "net", label: "Net changes" },
    ...this.sources().map(id => ({ id, label: id === "provider" ? "Provider edits" : "Command observations" })),
  ]);
  readonly page = signal<SessionChatChangesPage | null>(null);
  readonly files = signal<readonly ChangeFile[]>([]);
  readonly contents = signal<readonly DiffFileContent[]>([]);
  readonly activeFile = signal<string | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly wrap = signal(true);
  readonly offsets = signal<ReadonlyMap<string, number>>(new Map());
  private readonly client = inject(SessionChatClient);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly focusPending = signal(false);
  private readonly linePending = signal<string | undefined>(undefined);
  private readonly review = viewChild(DiffReviewComponent);
  private generation = 0;
  private readonly requests = new Map<
    string,
    {
      readonly scope: string;
      readonly requestId: string;
      readonly fileId?: string;
    }
  >();
  private queue: DiffFileRequest[] = [];
  private readonly nextLines = new Map<string, number>();
  private readonly previousOffsets = new Map<string, number[]>();

  constructor() {
    effect(() => {
      const target = this.target();
      if (this.unreachable()) { this.cancel(); this.busy.set(false); }
      else untracked(() => {
        this.source.set("net");
        this.sources.set([]);
        void this.load(target, 0, target.path);
      });
    });
    afterRenderEffect(() => {
      const fileId = this.linePending();
      if (fileId) {
        this.linePending.set(undefined);
        this.review()?.goTo(fileId);
      }
      if (!this.busy() && this.page() && this.focusPending()) {
        this.focusPending.set(false);
        const path = this.target().path;
        if (path) this.review()?.goTo(path);
        this.root
          .querySelector<HTMLElement>("ex-diff-review .review")
          ?.focus({ preventScroll: true });
      }
    });
    inject(DestroyRef).onDestroy(() => this.cancel());
  }
  private cancel(): void {
    this.generation++;
    for (const request of this.requests.values())
      this.client.cancel(request.scope, request.requestId);
    this.requests.clear();
    this.queue = [];
  }
  protected selectSource(source: string): void {
    if ((source !== "provider" && source !== "command" && source !== "net") ||
        source === this.source() || !this.sourceOptions().some(option => option.id === source)) return;
    this.source.set(source);
    void this.load(this.target(), 0, undefined, false);
  }

  async load(target = this.target(), offset = 0, path?: string, focus = true): Promise<void> {
    if (this.unreachable()) { this.reconnectRequested.emit(); return; }
    this.cancel();
    const generation = this.generation,
      requestId = crypto.randomUUID();
    this.focusPending.set(false);
    this.busy.set(true);
    this.error.set("");
    this.page.set(null);
    this.files.set([]);
    this.contents.set([]);
    this.offsets.set(new Map());
    this.nextLines.clear();
    this.previousOffsets.clear();
    this.requests.set(requestId, { scope: target.scopeId, requestId });
    const result = await this.client.changes(target.scopeId, {
      ...target,
      requestId,
      offset,
      path,
      source: this.source(),
    });
    if (generation !== this.generation) return;
    this.requests.delete(requestId);
    this.busy.set(false);
    if (!result.ok) {
      this.error.set(result.error.message);
      return;
    }
    const page = result.value;
    this.page.set(page);
    this.sources.set(page.sources ?? []);
    this.files.set(
      page.files.map((file) => ({
        ...file,
        id: file.path,
        rev: page.revision,
      })),
    );
    this.activeFile.set(path ?? page.files[0]?.path);
    if (page.content) this.applyContent(page, 0);
    this.focusPending.set(focus);
  }
  pageFiles(direction: -1 | 1): void {
    const page = this.page();
    if (page)
      void this.load(
        this.target(),
        direction < 0
          ? Math.max(0, page.offset - 100)
          : (page.nextOffset ?? page.offset),
      );
  }
  viewed(intent: {
    fileId: string;
    rev?: string | number;
    viewed: boolean;
  }): void {
    this.files.update((files) =>
      files.map((file) =>
        file.id === intent.fileId && file.rev === intent.rev
          ? { ...file, viewed: intent.viewed }
          : file,
      ),
    );
  }
  request(request: DiffFileRequest): void {
    if (this.unreachable()) { if (request.reason === 'retry' || request.reason === 'more' || request.reason === 'previous') this.reconnectRequested.emit(); return; }
    if (
      request.mode !== "changes" ||
      request.rev !== this.page()?.revision ||
      !this.files().some((file) => file.id === request.fileId)
    )
      return;
    if (
      this.queue.some((item) => item.fileId === request.fileId) ||
      [...this.requests.values()].some((item) => item.fileId === request.fileId)
    )
      return;
    if (
      request.reason !== "more" &&
      request.reason !== "previous" &&
      request.reason !== "retry" &&
      this.contents().some(
        (content) =>
          content.fileId === request.fileId && content.state === "ready",
      )
    )
      return;
    this.queue.push(request);
    this.pump();
  }
  private pump(): void {
    while (this.requests.size < 3 && this.queue.length) {
      const request = this.queue.shift();
      if (request) void this.readFile(request);
    }
  }
  private async readFile(request: DiffFileRequest): Promise<void> {
    const target = this.target(),
      page = this.page();
    if (!page) return;
    const generation = this.generation,
      requestId = crypto.randomUUID();
    const key = requestId + ":" + request.fileId;
    const lineOffset =
      request.reason === "previous"
        ? (this.previousOffsets.get(request.fileId)?.pop() ?? 0)
        : request.reason === "more"
          ? (this.nextLines.get(request.fileId) ?? 0)
          : (this.offsets().get(request.fileId) ?? 0);
    this.requests.set(key, {
      scope: target.scopeId,
      requestId,
      fileId: request.fileId,
    });
    this.putContent({
      fileId: request.fileId,
      rev: request.rev,
      mode: "changes",
      state: "loading",
    });
    const result = await this.client.changes(target.scopeId, {
      ...target,
      requestId,
      offset: page.offset,
      path: request.fileId,
      lineOffset,
      revision: page.revision,
      source: page.source,
    });
    if (generation !== this.generation) return;
    this.requests.delete(key);
    if (result.ok && result.value.revision === page.revision)
      this.applyContent(
        result.value,
        lineOffset,
        request.reason === "more" || request.reason === "previous",
      );
    else
      this.putContent({
        fileId: request.fileId,
        rev: page.revision,
        mode: "changes",
        state: "error",
        error: result.ok
          ? "These changes were updated. Reopen the review."
          : result.error.message,
      });
    this.pump();
  }
  private putContent(content: DiffFileContent): void {
    this.contents.update((contents) => [
      ...contents.filter((item) => item.fileId !== content.fileId).slice(-99),
      content,
    ]);
  }
  private applyContent(
    page: SessionChatChangesPage,
    offset: number,
    anchor = false,
  ): void {
    const content = page.content;
    if (!content) return;
    const previous = this.offsets().get(content.path) ?? 0;
    if (offset > previous)
      this.previousOffsets.set(
        content.path,
        [...(this.previousOffsets.get(content.path) ?? []), previous].slice(
          -100,
        ),
      );
    this.offsets.update((offsets) =>
      new Map(offsets).set(content.path, offset),
    );
    if (content.nextOffset !== null)
      this.nextLines.set(content.path, content.nextOffset);
    else this.nextLines.delete(content.path);
    const hunks: Array<{ id: string; heading: string; lines: DiffLine[] }> = [];
    for (const line of content.lines) {
      const heading = line.evidence ?? (offset ? `Changes · lines after ${offset}` : "Changes in this reply");
      let hunk = hunks.at(-1);
      if (hunk?.heading !== heading) {
        hunk = { id: `${content.path}:${line.id}`, heading, lines: [] };
        hunks.push(hunk);
      }
      hunk.lines.push(line);
    }
    this.putContent({
      fileId: content.path,
      rev: page.revision,
      mode: "changes",
      state: content.error ? "error" : "ready",
      error: content.error,
      hunks,
      hasMoreLines: content.nextOffset !== null,
      hasPreviousLines: offset > 0,
    });
    if (anchor) this.linePending.set(content.path);
  }
}
