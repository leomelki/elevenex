import {
  afterNextRender,
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
  FoldComponent,
  IconComponent,
  IconButtonComponent,
  ModalLayerComponent,
  SegmentedComponent,
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
    FoldComponent,
    IconComponent,
    IconButtonComponent,
    ModalLayerComponent,
    SegmentedComponent,
    DiffReviewComponent,
    SessionChatReviewComponent,
  ],
  providers: [RepositoryReviewStore],
  templateUrl: "./repository-review.component.html",
  styleUrl: "./repository-review.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(focusin)": "rememberSourceFocus($event)" },
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
  protected readonly inlineSources = signal(false);
  private sourceObserver?: ResizeObserver;
  private sourceFocusFrame?: number;
  private sourceFocus?: HTMLElement;
  private branchTimer?: ReturnType<typeof setTimeout>;
  private readonly replySelected = signal(false);
  readonly source = computed<RepositoryReviewSource | "reply">(() =>
    this.replySelected() && this.reply() ? "reply" : this.store.source(),
  );
  readonly picker = signal(false);
  readonly detailsOpen = signal(false);
  readonly details = signal<{
    readonly comparison: string;
    readonly page: RepositoryReviewPage | null;
    readonly reply: boolean;
  } | null>(null);
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
  readonly sourceSegments = computed(() =>
    this.options()
      .filter((option) => !option.disabled)
      .map((option) => ({
        id: option.id,
        label: option.label,
        title: option.detail,
        disabled: !this.active(),
      })),
  );
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
    afterNextRender(() => {
      this.measureSourceLayout();
      if (typeof ResizeObserver !== "undefined") {
        this.sourceObserver = new ResizeObserver(() =>
          this.measureSourceLayout(),
        );
        this.sourceObserver.observe(this.root);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.branchTimer);
      this.sourceObserver?.disconnect();
      if (this.sourceFocusFrame !== undefined)
        cancelAnimationFrame(this.sourceFocusFrame);
    });
    effect(() => {
      const reply = this.reply();
      untracked(() => this.replySelected.set(!!reply));
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
  protected rememberSourceFocus(event: FocusEvent): void {
    const target = event.target;
    this.sourceFocus =
      target instanceof HTMLElement &&
      target.closest(".source-menu, .source-tabs")
        ? target
        : undefined;
  }
  private measureSourceLayout(): void {
    const inline = this.root.clientWidth >= 720;
    if (inline === this.inlineSources()) return;
    const previous = this.root.querySelector(
      this.inlineSources() ? ".source-tabs" : ".source-menu",
    );
    const active = this.root.ownerDocument.activeElement;
    const moveFocus =
      previous?.contains(active) ||
      (active === this.root.ownerDocument.body &&
        this.sourceFocus?.isConnected &&
        previous?.contains(this.sourceFocus)) ||
      (!this.inlineSources() &&
        !!this.root.querySelector('.source-menu [aria-expanded="true"]'));
    this.inlineSources.set(inline);
    if (this.sourceFocusFrame !== undefined)
      cancelAnimationFrame(this.sourceFocusFrame);
    if (moveFocus)
      this.sourceFocusFrame = requestAnimationFrame(() => {
        this.sourceFocusFrame = requestAnimationFrame(() => {
          this.sourceFocusFrame = undefined;
          if (
            this.active() &&
            this.root.ownerDocument.hasFocus() &&
            !this.root.closest("[inert]")
          )
            this.root
              .querySelector<HTMLElement>(
                inline
                  ? '.source-tabs [aria-checked="true"]'
                  : ".source-menu button",
              )
              ?.focus({ preventScroll: true });
        });
      });
  }
  clearFilter(input: HTMLInputElement): void {
    this.store.filter("");
    input.focus({ preventScroll: true });
  }
  showDetails(): void {
    this.details.set({
      comparison: this.comparison(),
      page: this.source() === "reply" ? null : this.store.page(),
      reply: this.source() === "reply",
    });
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
      if (this.reply()) this.replySelected.set(true);
      return;
    }
    if (
      value !== "uncommitted" &&
      value !== "last-commit" &&
      value !== "branch"
    )
      return;
    this.replySelected.set(false);
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
