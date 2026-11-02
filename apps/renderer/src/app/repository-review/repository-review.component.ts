import {
  afterRenderEffect,
  viewChild,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from "@angular/core";
import type {
  RepositoryReviewPage,
  RepositoryReviewLocation,
  RepositoryReviewSource,
} from "@elevenex/shared";
import {
  ButtonComponent,
  DropdownComponent,
  EaseSwapComponent,
  FoldComponent,
  IconComponent,
  IconButtonComponent,
  ModalLayerComponent,
  type DropdownOption,
} from "../ui";
import { DiffReviewComponent, type DiffComment } from "../views";
import {
  SessionChatReviewComponent,
  type ChatReviewTarget,
} from "../session-chat/session-chat-review.component";
import {
  RepositoryReviewStore,
  type RepositoryReviewTarget,
} from "./repository-review.store";

export interface RepositoryLineQuestion {
  readonly location: RepositoryReviewLocation;
  readonly text: string;
}

@Component({
  selector: "ex-repository-review",
  imports: [
    ButtonComponent,
    DropdownComponent,
    EaseSwapComponent,
    FoldComponent,
    IconComponent,
    IconButtonComponent,
    ModalLayerComponent,
    DiffReviewComponent,
    SessionChatReviewComponent,
  ],
  providers: [RepositoryReviewStore],
  templateUrl: "./repository-review.component.html",
  styleUrl: "./repository-review.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepositoryReviewComponent {
  readonly target = input<RepositoryReviewTarget | null>(null);
  readonly reply = input<ChatReviewTarget | null>(null);
  readonly active = input(true);
  readonly unreachable = input<string>();
  readonly wide = input(false);
  readonly codeAvailable = input(false);
  readonly questionsAvailable = input(true);
  readonly feedback = input("");
  readonly wideChange = output<boolean>();
  readonly exitRequested = output<void>();
  readonly reconnectRequested = output<void>();
  readonly codeRequested = output<RepositoryReviewLocation>();
  readonly questionRequested = output<RepositoryLineQuestion>();
  readonly store = inject(RepositoryReviewStore);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly review = viewChild(DiffReviewComponent);
  private lastWindow = 0;
  private branchTimer?: ReturnType<typeof setTimeout>;
  readonly source = signal<RepositoryReviewSource | "reply">("uncommitted");
  readonly picker = signal(false);
  readonly detailsOpen = signal(false);
  readonly details = signal<{ readonly comparison: string; readonly page: RepositoryReviewPage | null; readonly reply: boolean } | null>(null);
  readonly branchQuery = signal("");
  readonly baseDraft = signal("");
  readonly options = computed<readonly DropdownOption[]>(() => [
    {
      id: "uncommitted",
      label: "Uncommitted",
      detail: "Staged, unstaged and untracked",
    },
    { id: "last-commit", label: "Last commit", detail: "Parent → HEAD" },
    {
      id: "branch",
      label: "Branch changes",
      detail: "Merge-base → HEAD · committed only",
    },
    {
      id: "reply",
      label: "Selected reply",
      detail: "Recorded agent patch · not repository state",
      disabled: !this.reply(),
    },
  ]);
  readonly comparison = computed(() => {
    if (this.source() === "reply")
      return "Recorded patch from the selected agent reply";
    const page = this.store.page();
    if (!page)
      return this.source() === "branch"
        ? "Merge-base → task HEAD · committed only"
        : this.source() === "last-commit"
          ? "Parent → HEAD · committed only"
          : "HEAD → index · index → working files";
    if (page.source === "uncommitted")
      return `${page.headSha?.slice(0, 8) ?? "Empty tree"} → index → working files`;
    return `${page.baseSha?.slice(0, 8) ?? "No parent"} → ${page.headSha?.slice(0, 8) ?? "No commits"} · committed only`;
  });
  readonly baseLabel = computed(() =>
    (this.store.base() || this.store.page()?.baseRef || "Choose base").replace(
      /^refs\/(heads|remotes)\//,
      "",
    ),
  );

  constructor() {
    afterRenderEffect(() => {
      const window = this.store.lineWindow();
      if (window && window.sequence !== this.lastWindow) {
        this.lastWindow = window.sequence;
        this.review()?.goTo(window.fileId);
      }
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.branchTimer));
    effect(() => {
      const reply = this.reply();
      if (reply) untracked(() => this.source.set("reply"));
      else if (untracked(this.source) === "reply")
        untracked(() => this.source.set(this.store.source()));
    });
    effect(() => {
      const target = this.target(),
        active = this.active() && this.source() !== "reply",
        offline = !!this.unreachable();
      untracked(() => this.store.connect(target, active, offline));
      if (!this.active() || offline) this.picker.set(false);
      if (!this.active()) this.detailsOpen.set(false);
    });
  }
  clearFilter(input: HTMLInputElement): void {
    this.store.filter("");
    input.focus({ preventScroll: true });
  }
  showDetails(): void {
    this.details.set({ comparison: this.comparison(), page: this.source() === "reply" ? null : this.store.page(), reply: this.source() === "reply" });
    this.detailsOpen.set(true);
  }
  refreshReview(): void {
    this.root
      .querySelector<HTMLButtonElement>(
        '[aria-label="Refresh repository review"]',
      )
      ?.focus({ preventScroll: true });
    this.store.refresh();
  }
  reconnect(): void {
    this.root
      .querySelector<HTMLButtonElement>(".source-bar ex-dropdown button")
      ?.focus({ preventScroll: true });
    this.reconnectRequested.emit();
  }
  choose(value: string): void {
    if (value === "reply") {
      if (this.reply()) this.source.set("reply");
      return;
    }
    if (
      value !== "uncommitted" &&
      value !== "last-commit" &&
      value !== "branch"
    )
      return;
    this.source.set(value);
    this.store.setSource(value);
  }
  openBase(): void {
    this.baseDraft.set(this.store.base() || this.store.page()?.baseRef || "");
    this.branchQuery.set("");
    this.picker.set(true);
    void this.store.searchBranches("");
  }
  searchBase(value: string): void {
    this.branchQuery.set(value);
    this.baseDraft.set(value);
    clearTimeout(this.branchTimer);
    this.branchTimer = setTimeout(() => {
      if (this.picker() && this.active()) void this.store.searchBranches(value);
    }, 150);
  }
  selectBase(ref: string): void {
    this.baseDraft.set(ref);
    this.store.setBase(ref);
    this.picker.set(false);
  }
  openCode(id: string): void {
    const location = this.location(id, "new", 1);
    if (location) this.codeRequested.emit(location);
  }
  question(comment: DiffComment): void {
    const location = this.location(comment.fileId, comment.side, comment.line);
    if (location && comment.rev === location.fileRev)
      this.questionRequested.emit({ location, text: comment.text });
  }
  private location(
    id: string,
    side: "old" | "new",
    line: number,
  ): RepositoryReviewLocation | null {
    const target = this.target(),
      page = this.store.page(),
      file = this.store.file(id);
    if (!target || !page || !file) return null;
    const actualSide = file.status === "D" ? "old" : side;
    return {
      ...target,
      source: page.source,
      revision: page.revision,
      fileId: id,
      fileRev: file.rev,
      path: actualSide === "old" ? (file.oldPath ?? file.path) : file.path,
      side: actualSide,
      contentRevision:
        actualSide === "old" ? file.oldRevision : file.newRevision,
      line,
      headSha: page.headSha,
      baseSha: page.baseSha,
    };
  }
}
