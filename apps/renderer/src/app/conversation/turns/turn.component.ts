import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  FoldComponent,
  IconComponent,
} from "../../ui";
import type {
  ChangedFile,
  TurnAction,
  TurnStatus,
  WorkStep,
} from "../conversation.models";
import { WorkTimelineComponent } from "./work-timeline.component";
import { NowLineComponent } from "./now-line.component";
import { OutcomeBarComponent } from "./outcome-bar.component";
import { TurnActsComponent } from "./turn-acts.component";
import { formatDuration, isProse, summarizeWork } from "./work-summary";
@Component({
  selector: "ex-turn",
  imports: [
    AutoHeightDirective,
    ButtonComponent,
    FoldComponent,
    IconComponent,
    WorkTimelineComponent,
    NowLineComponent,
    OutcomeBarComponent,
    TurnActsComponent,
  ],
  templateUrl: "./turn.component.html",
  styleUrl: "./turn.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.live]": 'status() === "live"',
    "[class.expanded]": "expanded()",
    tabindex: "0",
    "(keydown)": "onKey($event)",
  },
})
export class TurnComponent {
  readonly status = input<TurnStatus>("done");
  readonly steps = input<readonly WorkStep[]>([]);
  readonly answerBeforeStepId = input<string>();
  readonly duration = input(0);
  readonly elapsed = input(0);
  readonly files = input<readonly ChangedFile[]>([]);
  readonly error = input("");
  readonly open = input(false);
  readonly maxVisible = input(4);
  readonly author = input("Agent");
  readonly mark = input("EX");
  readonly time = input("");
  readonly stoppable = input(true);
  readonly retryable = input(true);
  readonly actions = input<readonly TurnAction[]>(['side-chat', 'fork', 'copy']);
  readonly stop = output<void>();
  readonly retry = output<void>();
  readonly action = output<TurnAction>();
  readonly openFile = output<string>();
  readonly review = output<void>();
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(
    () => this.toggled() ?? (this.status() === "live" || this.open()),
  );
  private readonly answerBoundary = computed(() => {
    const boundary = this.answerBeforeStepId();
    const index = this.steps().findIndex((step) => step.id === boundary);
    return index < 0 ? this.steps().length : index;
  });
  readonly precedingSteps = computed(() =>
    this.steps().slice(0, this.answerBoundary()),
  );
  readonly followingSteps = computed(() =>
    this.steps().slice(this.answerBoundary()),
  );
  readonly activeStep = computed(() => {
    const last = this.precedingSteps().at(-1);
    return this.status() === "live" && last?.status === "running" ? last : null;
  });
  readonly heldStep = signal<WorkStep | null>(null);
  readonly timelineSteps = computed(() =>
    this.precedingSteps().filter((step) => step.id !== this.activeStep()?.id),
  );
  readonly workLabel = computed(() => {
    const seconds = this.status() === 'live' ? this.elapsed() : this.duration();
    const label = this.status() === 'live' ? 'Working' : this.status() === 'stopped' ? 'Stopped' : this.status() === 'failed' ? 'Failed' : 'Worked';
    return seconds > 0 ? `${label}${this.status() === 'stopped' || this.status() === 'failed' ? ' after' : ''} ${formatDuration(seconds)}` : label;
  });
  readonly stepCount = computed(
    () => this.steps().filter((step) => !isProse(step)).length,
  );
  readonly facts = computed(() =>
    summarizeWork(
      this.steps().filter((step) => step.status !== "running"),
      this.files(),
    ),
  );
  protected readonly factsElement =
    viewChild<ElementRef<HTMLElement>>("factsRegion");
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
    effect((cleanup) => {
      const step = this.activeStep();
      if (step) {
        this.heldStep.set(step);
        return;
      }
      const timer = setTimeout(
        () => this.heldStep.set(null),
        this.status() === "live" ? 700 : 0,
      );
      cleanup(() => clearTimeout(timer));
    });
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
