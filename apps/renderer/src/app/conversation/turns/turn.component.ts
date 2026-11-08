import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnChanges,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { ButtonComponent, FoldComponent, IconComponent } from "../../ui";
import type {
  ChangedFile,
  TurnAction,
  TurnStatus,
  WorkStep,
} from "../conversation.models";
import { WorkTimelineComponent } from "./work-timeline.component";
import { OutcomeBarComponent } from "./outcome-bar.component";
import { TurnActsComponent } from "./turn-acts.component";
import { formatDuration, isProse, summarizeWork } from "./work-summary";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import type { ToolContentRequest } from "../tool-presentation";
import { ReplyMarkComponent } from "./reply-mark.component";
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
  },
})
export class TurnComponent implements OnChanges {
  /** Read once on mount, so streamed content and saved receipts never replay entry. */
  readonly isNew = input(false);
  protected readonly arriving = signal(false);
  private initialized = false;
  readonly status = input<TurnStatus>("done");
  readonly steps = input<readonly WorkStep[]>([]);
  readonly answerBeforeStepId = input<string>();
  readonly answerId = input<string>();
  readonly answer = input<string>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly contentRequested = output<ToolContentRequest>();
  protected readonly inspecting = signal(false);
  readonly duration = input(0);
  readonly elapsed = input(0);
  readonly files = input<readonly ChangedFile[]>([]);
  readonly filesTotal = input<number>();
  readonly error = input("");
  readonly open = input(false);
  readonly maxVisible = input(4);
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
  readonly workLabel = computed(() => {
    if (this.status() === "done" && !this.stepCount() && this.hasCommentary())
      return "Earlier messages";
    const seconds = this.status() === "live" ? this.elapsed() : this.duration();
    const label =
      this.status() === "live"
        ? "Working"
        : this.status() === "stopped"
          ? "Stopped"
          : this.status() === "failed"
            ? "Failed"
            : "Worked";
    return seconds > 0
      ? `${label}${this.status() === "stopped" || this.status() === "failed" ? " after" : ""} ${formatDuration(seconds)}`
      : label;
  });
  readonly stepCount = computed(
    () => this.steps().filter((step) => !isProse(step)).length,
  );
  private readonly hasCommentary = computed(() =>
    this.steps().some((step) => step.kind === "say" && !!step.text?.trim()),
  );
  protected readonly timelineSteps = computed(() =>
    this.stepCount()
      ? this.steps()
      : this.steps().filter((step) => step.kind === "say"),
  );
  protected readonly showWork = computed(
    () =>
      this.status() === "live" || this.stepCount() > 0 || this.hasCommentary(),
  );
  // Retain the last visible heading through Fold's exit and interrupted reopen.
  // History without work never mounts a heading or invents a Worked label.
  protected readonly workHeader = signal<{
    readonly label: string;
    readonly live: boolean;
  } | null>(null);
  readonly facts = computed(() =>
    summarizeWork(
      this.steps().filter((step) => step.status !== "running"),
      this.files(),
      this.filesTotal() ?? this.files().length,
    ),
  );
  protected readonly factsElement =
    viewChild<ElementRef<HTMLElement>>("factsRegion");
  private readonly workButton =
    viewChild<ElementRef<HTMLButtonElement>>("workButton");
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly workRegion = viewChild<unknown, ElementRef<HTMLElement>>(
    "workRegion",
    { read: ElementRef },
  );
  protected readonly factsClipped = signal(false);
  constructor() {
    afterRenderEffect((cleanup) => {
      const element = this.factsElement()?.nativeElement;
      this.facts();
      if (!element) return;
      const measure = () =>
        this.factsClipped.set(element.scrollWidth > element.clientWidth + 1);
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      cleanup(() => observer.disconnect());
    });
  }
  ngOnChanges(): void {
    if (!this.initialized) {
      this.initialized = true;
      this.arriving.set(this.isNew());
    }
    if (this.showWork()) {
      this.workHeader.set({
        label: this.workLabel(),
        live: this.status() === "live",
      });
    }
    const focused = this.host.nativeElement.ownerDocument.activeElement;
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
