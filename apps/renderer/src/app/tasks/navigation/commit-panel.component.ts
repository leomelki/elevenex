import { A11yModule, CdkTrapFocus } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnChanges,
  SimpleChanges,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  FoldComponent,
  IconComponent,
  KbdComponent,
  MorphFromMotion,
  StatusGlyphComponent,
  SwitchComponent,
  TickerComponent,
} from "../../ui";
import type {
  CommitFile,
  CommitFileProvider,
  CommitFileWindow,
  CommitIntent,
  CommitSelection,
} from "./commit-panel.models";

@Component({
  selector: "ex-commit-panel",
  imports: [
    A11yModule,
    AutoHeightDirective,
    ButtonComponent,
    FoldComponent,
    IconComponent,
    KbdComponent,
    StatusGlyphComponent,
    SwitchComponent,
    TickerComponent,
  ],
  templateUrl: "./commit-panel.component.html",
  styleUrl: "./commit-panel.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommitPanelComponent implements OnChanges {
  readonly open = input(false);
  readonly files = input<readonly CommitFile[]>([]);
  readonly running = input<readonly string[]>([]);
  readonly push = input(false);
  readonly fileProvider = input<CommitFileProvider>();
  readonly pushChange = output<boolean>();
  readonly closeRequested = output<void>();
  readonly commitRequested = output<CommitIntent>();
  protected readonly retained = signal(false);
  protected readonly presenting = signal(false);
  protected readonly message = signal("");
  protected readonly list = signal(false);
  protected readonly query = signal("");
  protected readonly all = signal(false);
  protected readonly includeUnstaged = signal(true);
  protected readonly excluded = signal<readonly string[]>([]);
  protected readonly includedSecrets = signal<readonly string[]>([]);
  protected readonly retry = signal(0);
  protected readonly cursor = signal<string | undefined>(undefined);
  private readonly secretFile = signal<CommitFile | null>(null);
  protected readonly remote = signal<CommitFileWindow | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly more = signal(false);
  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroy = inject(DestroyRef);
  private readonly layer = viewChild<ElementRef<HTMLElement>>("layer");
  private readonly scroll = viewChild<ElementRef<HTMLElement>>("scroll");
  private readonly trap = viewChild(CdkTrapFocus);
  private motion?: MorphFromMotion;
  private mode?: "open" | "closing";
  private opener?: HTMLElement;
  private focusTimer?: ReturnType<typeof setTimeout>;
  private readonly resize =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => this.fit());
  private readonly keptFiles = linkedSignal<
    { open: boolean; files: readonly CommitFile[] },
    readonly CommitFile[]
  >({
    source: () => ({ open: this.open(), files: this.files() }),
    computation: (next, previous) =>
      next.open ? next.files : (previous?.value ?? next.files),
  });
  protected readonly keptRunning = linkedSignal<
    { open: boolean; running: readonly string[] },
    readonly string[]
  >({
    source: () => ({ open: this.open(), running: this.running() }),
    computation: (next, previous) =>
      next.open ? next.running : (previous?.value ?? next.running),
  });
  protected readonly keptPush = linkedSignal<
    { open: boolean; push: boolean },
    boolean
  >({
    source: () => ({ open: this.open(), push: this.push() }),
    computation: (next, previous) =>
      next.open ? next.push : (previous?.value ?? next.push),
  });
  protected readonly selection = computed<CommitSelection>(() => ({
    includeUnstaged: this.includeUnstaged(),
    excluded: this.excluded(),
    includedSecrets: this.includedSecrets(),
  }));
  private readonly chosen = computed(() =>
    this.keptFiles().filter((file) => this.picked(file)),
  );
  protected readonly stats = computed(
    () =>
      this.remote()?.selected ?? {
        files: this.chosen().length,
        add: this.chosen().reduce((n, file) => n + file.add, 0),
        del: this.chosen().reduce((n, file) => n + file.del, 0),
        staged: this.chosen().filter((file) => file.staged).length,
        unstaged: this.chosen().filter((file) => !file.staged).length,
      },
  );
  protected readonly total = computed(
    () => this.remote()?.total ?? this.keptFiles().length,
  );
  protected readonly unstaged = computed(
    () =>
      this.remote()?.unstaged ??
      this.keptFiles().filter((file) => !file.staged).length,
  );
  private readonly matches = computed(
    () =>
      this.remote()?.items ??
      this.keptFiles()
        .filter((file) =>
          file.path.toLowerCase().includes(this.query().toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(this.canPick(b)) - Number(this.canPick(a)) ||
            Number(!!b.flag) - Number(!!a.flag) ||
            b.add + b.del - a.add - a.del ||
            a.path.localeCompare(b.path),
        ),
  );
  protected readonly matchCount = computed(
    () => this.remote()?.matches ?? this.matches().length,
  );
  protected readonly shown = computed(() =>
    this.query() || this.all()
      ? this.matches()
      : this.matches().slice(
          0,
          this.matches().filter((file) => file.flag && this.canPick(file))
            .length + 4,
        ),
  );
  protected readonly hidden = computed(() =>
    Math.max(0, this.matchCount() - this.shown().length),
  );
  protected readonly flagged = computed(() =>
    this.fileProvider()
      ? this.secretFile()
        ? [this.secretFile()!]
        : []
      : this.keptFiles()
          .filter((file) => file.flag)
          .slice(0, 1),
  );
  protected readonly runningNames = computed(
    () => this.remote()?.running ?? this.keptRunning(),
  );

  protected readonly runningCount = computed(
    () => this.remote()?.runningCount ?? this.runningNames().length,
  );

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      this.retry();
      const provider = this.fileProvider();
      if (!provider) return;
      const query = {
        ...this.selection(),
        query: this.query(),
        ...(this.cursor() ? { cursor: this.cursor() } : {}),
      };
      const abort = new AbortController();
      this.loading.set(true);
      this.error.set(null);
      const timer = setTimeout(
        () => {
          void provider(query, abort.signal).then(
            (result) => {
              if (!abort.signal.aborted) {
                this.remote.set(result);
                if (!this.secretFile())
                  this.secretFile.set(
                    result.items.find((file) => file.flag) ?? null,
                  );
                this.loading.set(false);
              }
            },
            (error) => {
              if (!abort.signal.aborted) {
                this.error.set(
                  error instanceof Error
                    ? error.message
                    : "The files could not be loaded.",
                );
                this.loading.set(false);
              }
            },
          );
        },
        query.query ? 100 : 0,
      );
      onCleanup(() => {
        clearTimeout(timer);
        abort.abort();
      });
    });
    afterRenderEffect(() => {
      const layer = this.layer()?.nativeElement;
      if (!layer) return;
      if (!this.open() && !this.mode) {
        this.retained.set(false);
        return;
      }
      if (this.open() && this.mode !== "open") {
        this.opener =
          this.root
            .closest("ex-git-bar")
            ?.querySelector<HTMLElement>(".primary") ?? undefined;
        this.presenting.set(true);
        layer.style.visibility = "visible";
        this.opener?.setAttribute("aria-expanded", "true");
        this.opener?.setAttribute("aria-haspopup", "dialog");
        this.fit();
        if (this.motion) void this.motion.retarget(true, this.opener);
        else
          this.motion = new MorphFromMotion(layer, this.opener, {
            noFace: true,
            fadeIn: 0.3,
          });
        this.mode = "open";
        this.resize?.observe(
          this.root.closest("ex-task-header") ??
            this.root.parentElement ??
            this.root,
        );
        clearTimeout(this.focusTimer);
        this.focusTimer = setTimeout(
          () => {
            if (this.open())
              this.trap()?.focusTrap.focusInitialElement({
                preventScroll: true,
              });
          },
          matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280,
        );
      } else if (!this.open() && this.mode === "open") {
        this.mode = "closing";
        clearTimeout(this.focusTimer);
        this.opener?.setAttribute("aria-expanded", "false");
        if (
          layer.contains(layer.ownerDocument.activeElement) &&
          !this.opener?.matches(":disabled")
        )
          this.opener?.focus({ preventScroll: true });
        void (
          this.motion?.retarget(false, this.opener) ?? Promise.resolve(true)
        ).then((done) => {
          if (done && !this.open() && !this.destroy.destroyed) {
            // Signal rendering removes the view later. Hide it before cancelling
            // the filled exit frame so the natural, full-size box cannot flash.
            layer.style.visibility = "hidden";
            this.presenting.set(false);
            this.retained.set(false);
            this.motion?.dispose();
            this.motion = undefined;
            this.mode = undefined;
            this.resize?.disconnect();
          }
        });
      }
      this.shown();
      this.list();
      this.edge();
    });
    const outside = (event: MouseEvent) => {
      if (
        this.open() &&
        event.target instanceof Node &&
        !this.layer()?.nativeElement.contains(event.target) &&
        !this.root.closest("ex-git-bar")?.contains(event.target)
      )
        this.closeRequested.emit();
    };
    const escape = (event: KeyboardEvent) => {
      if (this.open() && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeRequested.emit();
      }
    };
    this.root.ownerDocument.addEventListener("mousedown", outside);
    this.root.ownerDocument.addEventListener("keydown", escape, true);
    this.destroy.onDestroy(() => {
      clearTimeout(this.focusTimer);
      this.motion?.dispose();
      this.resize?.disconnect();
      this.root.ownerDocument.removeEventListener("mousedown", outside);
      this.root.ownerDocument.removeEventListener("keydown", escape, true);
      this.opener?.removeAttribute("aria-expanded");
      this.opener?.removeAttribute("aria-haspopup");
    });
  }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes["open"] && this.open() && !this.retained()) {
      this.retained.set(true);
      this.presenting.set(false);
      this.message.set("");
      this.list.set(false);
      this.query.set("");
      this.all.set(false);
      this.cursor.set(undefined);
      this.includeUnstaged.set(true);
      this.excluded.set([]);
      this.includedSecrets.set([]);
      this.remote.set(null);
      this.secretFile.set(null);
      this.error.set(null);
    }
  }
  protected readonly increment = (value: number) => value + 1;
  protected canPick(file: CommitFile): boolean {
    return this.includeUnstaged() || file.staged;
  }
  protected picked(file: CommitFile): boolean {
    return (
      this.canPick(file) &&
      !this.excluded().includes(file.path) &&
      (!file.flag || this.includedSecrets().includes(file.path))
    );
  }
  protected flip(file: CommitFile): void {
    if (!this.canPick(file) || this.loading()) return;
    if (file.flag)
      this.includedSecrets.update((paths) =>
        paths.includes(file.path)
          ? paths.filter((path) => path !== file.path)
          : [...paths, file.path],
      );
    else
      this.excluded.update((paths) =>
        paths.includes(file.path)
          ? paths.filter((path) => path !== file.path)
          : [...paths, file.path],
      );
  }
  protected filter(value: string): void {
    this.query.set(value);
    this.cursor.set(undefined);
  }
  protected setUnstaged(value: boolean): void {
    this.includeUnstaged.set(value);
    this.cursor.set(undefined);
  }
  protected edge(): void {
    const scroll = this.scroll()?.nativeElement;
    this.more.set(
      !!scroll &&
        scroll.scrollHeight > scroll.clientHeight + scroll.scrollTop + 2,
    );
  }
  protected commit(): void {
    if (!this.open() || this.loading() || this.error() || !this.stats().files)
      return;
    this.commitRequested.emit({
      message: this.message().trim(),
      files: this.chosen().map((file) => file.path),
      push: this.push(),
      selection: this.selection(),
      ...(this.remote() ? { revision: this.remote()!.revision } : {}),
    });
  }
  protected messageKey(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.commit();
    }
  }
  protected key(event: KeyboardEvent): void {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      this.commit();
    }
  }
  private fit(): void {
    const layer = this.layer()?.nativeElement;
    if (layer)
      layer.style.width = `${Math.min(460, (this.root.closest("ex-task-header")?.getBoundingClientRect().width ?? window.innerWidth) - 24)}px`;
  }
}
