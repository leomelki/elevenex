import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnChanges,
  type TemplateRef,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import {
  AutoHeightDirective,
  EaseSwapComponent,
  FoldComponent,
  IconComponent,
} from "../../ui";
import type { WorkStep } from "../conversation.models";
import type { ToolContentRequest } from "../tool-presentation";
import { MarkdownComponent } from "../markdown/markdown.component";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import { NowLineComponent } from "./now-line.component";
import { ToolStepComponent } from "./tool-step.component";
import {
  earlierWorkIds,
  workTimelineRows,
  type WorkTimelineRow,
} from "./work-timeline-layout";
import { formatDuration, isProse, stepIcon, stepVerb } from "./work-summary";

@Component({
  selector: "ex-work-timeline",
  imports: [
    NgTemplateOutlet,
    AutoHeightDirective,
    EaseSwapComponent,
    FoldComponent,
    IconComponent,
    MarkdownComponent,
    NowLineComponent,
    ToolStepComponent,
  ],
  templateUrl: "./work-timeline.component.html",
  styleUrl: "./work-timeline.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(focusin)": "focusChanged($event)",
    "(focusout)": "focusChanged($event)",
  },
})
export class WorkTimelineComponent implements OnChanges {
  readonly steps = input<readonly WorkStep[]>([]);
  readonly live = input(false);
  readonly expanded = input(true);
  readonly maxVisible = input(4);
  readonly answer = input<string>();
  readonly answerId = input<string>();
  readonly answerBeforeStepId = input<string>();
  readonly answerTemplate = input<TemplateRef<unknown>>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly openFile = output<string>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly contentRequested = output<ToolContentRequest>();
  readonly inspectionChanged = output<boolean>();
  readonly earlierOpen = signal(false);
  readonly openGroups = signal<ReadonlySet<string>>(new Set());
  private readonly inspected = signal<ReadonlySet<string>>(new Set());
  private readonly focused = signal<string | null>(null);
  private readonly focusedGroup = signal<string | null>(null);
  protected readonly earlierFocused = signal(false);
  protected readonly arrivals = signal<ReadonlySet<string>>(new Set());
  private previousIds: ReadonlySet<string> | undefined;
  private previousLast: string | undefined;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly replyId = computed(() => this.answerId() ?? "$answer");
  private readonly ordered = computed<readonly WorkStep[]>(() => {
    if (this.answer() === undefined && !this.answerTemplate())
      return this.steps();
    const index = this.steps().findIndex(
      (step) => step.id === this.answerBeforeStepId(),
    );
    const boundary = index < 0 ? this.steps().length : index;
    return [
      ...this.steps().slice(0, boundary),
      { id: this.replyId(), kind: "say", text: this.answer() ?? "" },
      ...this.steps().slice(boundary),
    ];
  });
  readonly rows = computed(() => workTimelineRows(this.ordered()));
  private readonly earlier = computed(() =>
    earlierWorkIds(this.rows(), this.maxVisible()),
  );
  private readonly pinned = computed(
    () =>
      new Set([
        ...this.inspected(),
        ...(this.focused() ? [this.focused()!] : []),
      ]),
  );
  private readonly pinnedGroups = computed(
    () =>
      new Set(
        this.rows()
          .filter(
            (row) =>
              row.group?.id === row.step.id &&
              row.group.items.some((step) => this.pinned().has(step.id)),
          )
          .map((row) => row.step.id),
      ),
  );
  readonly hiddenCount = computed(
    () => this.rows().filter((row) => this.agedOut(row)).length,
  );
  protected readonly earlierCount = computed(() => this.earlier().size);
  protected readonly showEarlier = computed(
    () =>
      this.expanded() &&
      (this.earlierCount() > 1 || this.earlierOpen() || this.earlierFocused()),
  );
  protected readonly earlierLabel = computed(() =>
    this.earlierOpen()
      ? "Show fewer steps"
      : this.hiddenCount()
        ? `${this.hiddenCount()} earlier steps`
        : "All steps shown",
  );
  readonly prose = isProse;
  readonly icon = stepIcon;
  readonly verb = (step: WorkStep): string =>
    stepVerb(step, step.status === "running");
  readonly duration = formatDuration;

  ngOnChanges(): void {
    const steps = this.ordered();
    const previousLastIndex = steps.findIndex(
      (step) => step.id === this.previousLast,
    );
    const ids = new Set(steps.map((step) => step.id));
    if (this.previousIds && this.live()) {
      const incoming = steps.filter(
        (step, index) =>
          index > previousLastIndex && !this.previousIds?.has(step.id),
      );
      this.arrivals.update(
        (current) =>
          new Set(
            [...current]
              .filter((id) => ids.has(id))
              .concat(incoming.map((step) => step.id)),
          ),
      );
    }
    this.previousIds = ids;
    this.previousLast = steps
      .filter((step) => step.id !== "$answer")
      .at(-1)?.id;
    const previousInspection = this.inspected().size + this.openGroups().size;
    this.inspected.update(
      (current) => new Set([...current].filter((id) => ids.has(id))),
    );
    const groups = new Set(
      this.rows().flatMap((row) => (row.group ? [row.group.id] : [])),
    );
    this.openGroups.update(
      (current) => new Set([...current].filter((id) => groups.has(id))),
    );
    if (previousInspection !== this.inspected().size + this.openGroups().size)
      this.reportInspection();
  }
  protected agedOut(row: WorkTimelineRow): boolean {
    return (
      !this.earlierOpen() &&
      this.earlier().has(row.step.id) &&
      !this.pinned().has(row.step.id) &&
      (!row.group ||
        (!this.pinnedGroups().has(row.group.id) &&
          !this.openGroups().has(row.group.id) &&
          this.focusedGroup() !== row.group.id))
    );
  }
  protected visible(row: WorkTimelineRow): boolean {
    if (row.step.id === this.replyId()) return true;
    // A focused latest reply can become commentary while history is collapsed.
    // Keep it readable until focus leaves; explicit collapse focuses its control.
    if (row.step.id === this.focused()) return true;
    if (row.step.status === "running" && this.live()) return true;
    if (!this.expanded()) return false;
    if (isProse(row.step)) return true;
    return !this.agedOut(row) && (!row.group || this.groupOpen(row));
  }
  protected groupVisible(row: WorkTimelineRow): boolean {
    return (
      !!row.group &&
      row.group.id === row.step.id &&
      this.expanded() &&
      !this.agedOut(row)
    );
  }
  protected groupOpen(row: WorkTimelineRow): boolean {
    return (
      !!row.group &&
      (this.openGroups().has(row.group.id) ||
        this.pinnedGroups().has(row.group.id))
    );
  }
  toggleGroup(id: string): void {
    const row = this.rows().find((row) => row.group?.id === id);
    const wasOpen = !!row && this.groupOpen(row);
    this.openGroups.update((current) => {
      const next = new Set(current);
      if (wasOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!this.openGroups().has(id)) {
      const group = this.rows().find((row) => row.group?.id === id)?.group;
      this.inspected.update(
        (current) =>
          new Set(
            [...current].filter(
              (key) => !group?.items.some((step) => step.id === key),
            ),
          ),
      );
    }
    this.reportInspection();
  }
  protected toggleEarlier(): void {
    if (!this.earlierOpen() && !this.hiddenCount()) return;
    this.earlierOpen.update((open) => !open);
    if (!this.earlierOpen()) {
      this.inspected.update(current => new Set([...current].filter(id => !this.earlier().has(id))));
      this.openGroups.update(current => new Set([...current].filter(id => !this.earlier().has(id))));
    }
    this.reportInspection();
  }
  protected toolExpanded(id: string, expanded: boolean): void {
    this.inspected.update((current) => {
      const next = new Set(current);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
    this.reportInspection();
  }
  protected focusChanged(event: FocusEvent): void {
    const target =
      event.type === "focusout" ? event.relatedTarget : event.target;
    const element =
      target instanceof Element && this.host.nativeElement.contains(target)
        ? target
        : null;
    this.focused.set(
      element?.closest<HTMLElement>("[data-work-step]")?.dataset["workStep"] ??
        null,
    );
    const groupControl = !!element?.closest(".group");
    this.focusedGroup.set(groupControl ? this.focused() : null);
    if (groupControl) this.focused.set(null);
    this.earlierFocused.set(!!element?.closest(".earlier"));
    this.reportInspection();
  }
  private reportInspection(): void {
    this.inspectionChanged.emit(
      this.inspected().size > 0 ||
        this.focused() !== null ||
        this.focusedGroup() !== null ||
        this.earlierFocused() ||
        this.openGroups().size > 0,
    );
  }
}
