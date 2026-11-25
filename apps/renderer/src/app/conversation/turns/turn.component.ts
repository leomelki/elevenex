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
import { ButtonComponent, FoldComponent, IconComponent, StatusGlyphComponent, TooltipDirective } from "../../ui";
import type { SessionAgentReturn } from '@elevenex/shared';
import { AgentMarkComponent } from '../composer/agent-mark.component';
import { DatePipe } from '@angular/common';
import { agentControl, agentWorkState, sessionAgentTitle, type AgentWorkCard, type AgentWorkIntent } from '../agents/agent-work.models';
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
import type { ToolContentRequest, ToolDetailsProvider, ToolImageProvider } from "../tool-presentation";
import { ReplyMarkComponent } from "./reply-mark.component";
import { TurnWorkPanelComponent } from './turn-work-panel.component';

// Intent tiers for warming saved activity. Resting over the reply is a weak
// signal and must survive scroll fly-through; resting on Worked itself is
// strong; pressing it starts at once so the read overlaps the click gesture.
const WORK_PRELOAD_INTENT_MS = 220;
const WORK_BUTTON_INTENT_MS = 60;
// Only a read that outlasts an instant-feeling response gets a pending cue.
export const WORK_PENDING_CUE_MS = 120;
@Component({
  selector: "ex-turn",
  imports: [
    AgentMarkComponent,
    DatePipe,
    StatusGlyphComponent,
    TooltipDirective,
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
    "[class.pending]": "workPending()",
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
  private readonly workButtonHovered = signal(false);
  private readonly workPressed = signal(false);
  protected readonly workFocused = signal(false);
  private reopenToolIds: readonly string[] = [];
  readonly answerBeforeStepId = input<string>();
  readonly answerId = input<string>();
  readonly answer = input<string>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly inspectTool = input<ToolDetailsProvider>();
  readonly toolImages = input<ToolImageProvider>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly contentRequested = output<ToolContentRequest>();
  readonly agentCards = input<readonly AgentWorkCard[]>([]);
  readonly returnedTo = input<readonly SessionAgentReturn[]>([]);
  readonly agentNavigationDisabled = input(false);
  readonly agentRequested = output<AgentWorkIntent>();
  protected readonly agentState = agentWorkState;
  protected readonly agentTitle = sessionAgentTitle;
  protected openAgent(card: AgentWorkCard, event: Event): void {
    if (card.target)
      this.agentRequested.emit({ target: card.target, action: card.status === 'waiting' && card.target.kind === 'session' ? 'answer' : 'open', origin: agentControl(event) });
  }
  protected followHandoff(receipt: SessionAgentReturn, event: Event): void {
    this.agentRequested.emit({ target: { kind: 'session', session: receipt.recipient }, action: 'return', origin: agentControl(event) });
  }
  protected readonly inspecting = signal(false);
  readonly duration = input(0);
  readonly elapsed = input(0);
  readonly files = input<readonly ChangedFile[]>([]);
  readonly filesTotal = input<number>();
  readonly reviewAvailable = input(false);
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
  readonly fileLink = output<string>();
  readonly reviewFile = output<string>();
  readonly review = output<void>();
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(
    () =>
      this.toggled() ??
      (this.status() === "live" || this.open() || this.inspecting()),
  );
  /** Dwell before warming closed saved activity, or undefined without intent. */
  private readonly workIntentDelay = computed(() => {
    if (!this.deferredWork() || this.expanded()) return undefined;
    if (this.workPressed()) return 0;
    if (this.workButtonHovered()) return WORK_BUTTON_INTENT_MS;
    return this.workHovered() || this.workFocused() ? WORK_PRELOAD_INTENT_MS : undefined;
  });
  /** Opened activity that is still reading after an instant-feeling interval. */
  private readonly workWaiting = computed(() => {
    const work = this.deferredWork();
    return !!work?.busy && !work.ready && !work.error && this.expanded();
  });
  protected readonly workPending = signal(false);
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
          this.agentCards().length,
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
    // One hint spans a dwell that escalates from the reply to Worked or a
    // press; it ends when intent leaves or the disclosure opens.
    let hinting = false;
    effect(cleanup => {
      const delay = this.workIntentDelay();
      if (delay === undefined) {
        if (hinting && !destroy.destroyed) untracked(() => this.workHintEnded.emit());
        hinting = false;
        return;
      }
      if (hinting) return;
      const start = () => {
        hinting = true;
        this.workHint.emit();
      };
      if (!delay) {
        untracked(start);
        return;
      }
      const timer = setTimeout(start, delay);
      cleanup(() => clearTimeout(timer));
    });
    effect(cleanup => {
      if (!this.workWaiting()) {
        this.workPending.set(false);
        return;
      }
      const timer = setTimeout(() => this.workPending.set(true), WORK_PENDING_CUE_MS);
      cleanup(() => clearTimeout(timer));
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
      this.workButtonHovered.set(false);
      this.workPressed.set(false);
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
    if (event.pointerType !== 'mouse') return;
    this.workHovered.set(inside);
    if (!inside) {
      this.workButtonHovered.set(false);
      this.workPressed.set(false);
    }
  }

  protected trackWorkButton(event: PointerEvent, inside: boolean): void {
    if (event.pointerType === 'mouse') this.workButtonHovered.set(inside);
  }

  /** Start reading on press rather than release. A touch press may begin a scroll. */
  protected pressWork(event: PointerEvent | KeyboardEvent): void {
    if (event instanceof KeyboardEvent
      ? event.repeat || (event.key !== 'Enter' && event.key !== ' ')
      : event.pointerType === 'touch' || event.button !== 0) return;
    this.workPressed.set(true);
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
