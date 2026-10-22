import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
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
  readonly stop = output<void>();
  readonly retry = output<void>();
  readonly action = output<TurnAction>();
  readonly openFile = output<string>();
  readonly review = output<void>();
  readonly toggled = signal<boolean | null>(null);
  readonly expanded = computed(
    () => this.toggled() ?? (this.status() === "live" || this.open()),
  );
  readonly activeStep = computed(() =>
    this.status() === "live"
      ? ([...this.steps()]
          .reverse()
          .find((step) => step.status === "running") ?? null)
      : null,
  );
  readonly heldStep = signal<WorkStep | null>(null);
  readonly completedSteps = computed(() =>
    this.steps().filter((step) => step.status !== "running"),
  );
  readonly workLabel = computed(
    () =>
      `${this.status() === "live" ? "Working" : this.status() === "stopped" ? "Stopped after" : this.status() === "failed" ? "Failed after" : "Worked"} ${formatDuration(this.status() === "live" ? this.elapsed() : this.duration())}`,
  );
  readonly stepCount = computed(
    () => this.steps().filter((step) => !isProse(step)).length,
  );
  readonly facts = computed(() => summarizeWork(this.steps(), this.files()));
  constructor() {
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
    if (action) {
      event.preventDefault();
      this.action.emit(action);
    }
  }
}
