import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  type OnChanges,
  type SimpleChanges,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
  untracked,
} from "@angular/core";
import { ButtonComponent, FoldComponent, IconComponent } from "../../ui";
import type {
  ChangedFile,
  DeferredTurnWork,
  TurnAction,
  TurnStatus,
  TurnWorkAction,
  TurnWorkToggle,
  WorkStep,
} from "../conversation.models";
import { WorkTimelineComponent } from "./work-timeline.component";
import { OutcomeBarComponent } from "./outcome-bar.component";
import { TurnActsComponent } from "./turn-acts.component";
import { formatDuration, isProse, summarizeWork } from "./work-summary";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import type { ToolContentRequest, ToolDetailsProvider } from "../tool-presentation";
import { ReplyMarkComponent } from "./reply-mark.component";
import { TurnWorkPanelComponent } from './turn-work-panel.component';

const WORK_PRELOAD_INTENT_MS = 220;
@Component({
  selector: "ex-turn",
  imports: [
    ButtonComponent,
    FoldComponent,
    IconComponent,
    WorkTimelineComponent,
    OutcomeBarComponent,
    ReplyMarkComponent,
    TurnActsComponent,
    TurnWorkPanelComponent,
  ],
  templateUrl: "./turn.component.html",
  styleUrl: "./turn.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.live]": 'status() === "live"',
    "[class.expanded]": "expanded()",
    "[class.arriving]": "arriving()",
    tabindex: "0",
    "(keydown)": "onKey($event)",
    "(animationend)": "arrivalFinished($event)",
    "(focusin)": "arriving.set(false)",
    "(pointerenter)": "trackWorkPointer($event, true)",
    "(pointerleave)": "trackWorkPointer($event, false)",
  },
})
export class TurnComponent implements OnChanges {
  /** Read once on mount, so streamed content and saved receipts never replay entry. */
  readonly isNew = input(false);
  protected readonly arriving = signal(false);
  private initialized = false;
  readonly status = input<TurnStatus>("done");
  readonly keepWorkOnCompletion = input(false);
  readonly steps = input<readonly WorkStep[]>([]);
  readonly deferredWork = input<DeferredTurnWork>();
  readonly workToggled = output<TurnWorkToggle>();
  readonly workHint = output<void>();
  readonly workHintEnded = output<void>();
  readonly workRequested = output<TurnWorkAction>();
  readonly workLayoutChanging = output<HTMLElement>();
  protected readonly workId = 'work-' + crypto.randomUUID();
  private readonly workHovered = signal(false);
  protected readonly workFocused = signal(false);
  private reopenToolIds: readonly string[] = [];
  readonly answerBeforeStepId = input<string>();
  readonly answerId = input<string>();
  readonly answer = input<string>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly inspectTool = input<ToolDetailsProvider>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly contentRequested = output<ToolContentRequest>();
  protected readonly inspecting = signal(false);
  readonly duration = input(0);
  readonly elapsed = input(0);
  readonly files = input<readonly ChangedFile[]>([]);
  readonly filesTotal = input<number>();
  readonly filesDiff = input<{ readonly add: number; readonly del: number }>();
  readonly sharedChanges = input(false);
  readonly error = input("");
  readonly open = input(false);
  readonly maxVisible = input(5);
  readonly author = input("Agent");
  readonly mark = input("EX");
  readonly harness = input<string>();
  readonly time = input("");
  readonly reach = input<{
    readonly machine: string;
    readonly since: number;
  }>();
  protected readonly reachTime = computed(() => {
    const since = this.reach()?.since;
    return since
      ? new Date(since).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "the connection was lost";
  });
  readonly stoppable = input(true);
  readonly retryable = input(true);
  readonly actions = input<readonly TurnAction[]>([
    "side-chat",
    "fork",
    "copy",
  ]);
  readonly stop = output<void>();
  readonly retry = output<void>();
  readonly action = output<TurnAction>();
  readonly openFile = output<string>();
  readonly review = output<void>();
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(
    () =>
      this.toggled() ??
      (this.status() === "live" || this.open() || this.inspecting()),
  );
  private readonly workHintActive = computed(() =>
    !!this.deferredWork() && !this.expanded() && (this.workHovered() || this.workFocused()));
  /** Epoch ms when a live turn began; it then counts its own elapsed time. */
  readonly startedAt = input<number>();
  private readonly now = signal(Date.now());
  private readonly liveSeconds = computed(() => {
    const start = this.startedAt();
    const counted =
      start === undefined ? 0 : Math.max(0, (this.now() - start) / 1000);
    return Math.max(this.elapsed(), counted);
  });
  /** The verb stays prominent; the time reads as quieter, secondary detail. */
  readonly workLabel = computed(() => {
    const status = this.status();
    const live = status === "live";
    const seconds = live ? this.liveSeconds() : this.duration();
    const verb = live
      ? "Working"
      : status === "stopped"
        ? "Stopped"
        : status === "failed"
          ? "Failed"
          : "Worked";
    const time =
      seconds >= 1
        ? `${status === "stopped" || status === "failed" ? "after" : "for"} ${formatDuration(seconds)}`
        : "";
    return { verb, time };
  });
  readonly stepCount = computed(
    () => this.steps().filter((step) => !isProse(step)).length,
  );
  protected readonly timelineSteps = computed(() =>
    this.deferredWork() || this.stepCount()
      ? this.steps()
      : this.steps().filter((step) => step.kind === "say"),
  );
  protected readonly showWork = computed(
    () => !!this.deferredWork() || this.status() === "live" || this.timelineSteps().length > 0,
  );
  protected readonly facts = computed(() =>
    this.status() === "live"
      ? []
      : summarizeWork(
          this.steps().filter((step) => step.status !== "running"),
          this.files(),
          this.filesTotal() ?? this.files().length,
          this.deferredWork(),
          this.sharedChanges(),
          this.filesDiff(),
        ),
  );
  private readonly factsElement =
    viewChild<ElementRef<HTMLElement>>("factsRegion");
  protected readonly factsClipped = signal(false);
  // Retain the last visible heading through Fold's exit and interrupted reopen.
  // History without work never mounts a heading or invents a Worked label.
  protected readonly workHeader = linkedSignal<
    {
      readonly show: boolean;
      readonly verb: string;
      readonly time: string;
      readonly live: boolean;
    },
    {
      readonly verb: string;
      readonly time: string;
      readonly live: boolean;
    } | null
  >({
    source: () => ({
      show: this.showWork(),
      ...this.workLabel(),
      live: this.status() === "live",
    }),
    computation: ({ show, verb, time, live }, previous) =>
      show ? { verb, time, live } : (previous?.value ?? null),
  });
  private readonly workButton =
    viewChild<ElementRef<HTMLButtonElement>>("workButton");
  private readonly workPanel = viewChild(TurnWorkPanelComponent, { read: ElementRef });
  private readonly timeline = viewChild(WorkTimelineComponent);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly workRegion = viewChild<unknown, ElementRef<HTMLElement>>(
    "workRegion",
    { read: ElementRef },
  );
  constructor() {
    let open = false;
    effect(() => {
      const next = !!this.deferredWork() && this.expanded();
      if (next === open) return;
      open = next;
      untracked(() => this.workToggled.emit({ open: next, toolIds: next ? this.reopenToolIds : [] }));
    });
    const destroy = inject(DestroyRef);
    effect(cleanup => {
      if (!this.workHintActive()) return;
      let started = false;
      const timer = setTimeout(() => {
        if (!this.workHintActive()) return;
        started = true;
        this.workHint.emit();
      }, WORK_PRELOAD_INTENT_MS);
      cleanup(() => {
        clearTimeout(timer);
        if (started && !destroy.destroyed) untracked(() => this.workHintEnded.emit());
      });
    });
    afterRenderEffect((onCleanup) => {
      const element = this.factsElement()?.nativeElement;
      this.facts();
      if (!element) return;
      const measure = () =>
        this.factsClipped.set(element.scrollWidth > element.clientWidth + 1);
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
    // Only a live turn with a known start ticks; settled turns stay still.
    effect((onCleanup) => {
      if (this.status() !== "live" || this.startedAt() === undefined) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized) {
      this.initialized = true;
      this.arriving.set(this.isNew());
    }
    if (changes["status"]?.previousValue === "live" && this.status() !== "live" &&
        this.keepWorkOnCompletion() && this.toggled() === null)
      this.toggled.set(true);
    const focused = this.host.nativeElement.ownerDocument.activeElement;
    const work = this.deferredWork(), previous = changes['deferredWork']?.previousValue as DeferredTurnWork | undefined;
    if (changes['deferredWork'] && work && this.expanded()) {
      if (!previous) this.reopenToolIds = this.timeline()?.activeToolIds() ?? [];
      if (work.ready !== previous?.ready || work.error !== previous?.error) this.notifyWorkLayout();
    }
    if (changes['deferredWork'] && previous?.error && !work?.error && this.workPanel()?.nativeElement.contains(focused))
      (this.workButton()?.nativeElement ?? this.host.nativeElement).focus({ preventScroll: true });
    if (
      !this.showWork() &&
      this.workRegion()?.nativeElement.contains(focused)
    ) {
      this.host.nativeElement.focus({ preventScroll: true });
    } else if (
      focused instanceof HTMLElement &&
      this.host.nativeElement.contains(focused)
    ) {
      const id =
        focused.closest<HTMLElement>("[data-work-step]")?.dataset["workStep"];
      if (
        id &&
        id !== (this.answerId() ?? "$answer") &&
        !this.steps().some((step) => step.id === id)
      ) {
        this.workButton()?.nativeElement.focus({ preventScroll: true });
      }
    }
  }

  protected toggleWork(): void {
    const open = !this.expanded();
    if (!open) {
      if (this.deferredWork()?.ready) this.reopenToolIds = this.timeline()?.activeToolIds() ?? [];
      // Closing cancels the read. Require fresh hover or focus before warming it again.
      this.workHovered.set(false);
      this.workFocused.set(false);
    }
    this.notifyWorkLayout();
    this.toggled.set(open);
  }

  protected notifyWorkLayout(): void {
    const button = this.workButton()?.nativeElement;
    if (button) this.workLayoutChanging.emit(button);
  }

  protected trackWorkPointer(event: PointerEvent, inside: boolean): void {
    if (event.pointerType === 'mouse') this.workHovered.set(inside);
  }

  protected focusWork(): void {
    this.workFocused.set(!!this.workButton()?.nativeElement.matches(':focus-visible'));
  }

  protected requestWork(action: TurnWorkAction): void {
    this.workButton()?.nativeElement.focus({ preventScroll: true });
    this.workRequested.emit(action);
  }

  protected arrivalFinished(event: AnimationEvent): void {
    // Ignore the mark's entry/breathing and animations inside streamed content.
    if (event.target === event.currentTarget) this.arriving.set(false);
  }
  onKey(event: KeyboardEvent): void {
    if (
      event.target !== event.currentTarget ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const action: TurnAction | undefined =
      event.key.toLowerCase() === "s"
        ? "side-chat"
        : event.key.toLowerCase() === "f"
          ? "fork"
          : event.key.toLowerCase() === "c"
            ? "copy"
            : undefined;
    if (action && this.actions().includes(action)) {
      event.preventDefault();
      this.action.emit(action);
    }
  }
}
