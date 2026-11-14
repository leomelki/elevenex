import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnChanges,
  type SimpleChanges,
  type TemplateRef,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import {
  AutoHeightDirective,
  FoldComponent,
  IconComponent,
  StatusGlyphComponent,
  TickerComponent,
} from "../../ui";
import type { WorkStep } from "../conversation.models";
import type { ToolContentRequest } from "../tool-presentation";
import { MarkdownComponent } from "../markdown/markdown.component";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import { NowLineComponent } from "./now-line.component";
import { ToolStepComponent } from "./tool-step.component";
import {
  isUnfinishedWork,
  workTimelineRows,
  type WorkTimelineRow,
} from "./work-timeline-layout";
import { formatDuration, isProse, stepIcon, stepVerb } from "./work-summary";

@Component({
  selector: "ex-work-timeline",
  imports: [
    NgTemplateOutlet,
    AutoHeightDirective,
    FoldComponent,
    IconComponent,
    StatusGlyphComponent,
    TickerComponent,
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
  readonly maxVisible = input(5);
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
  readonly openGroups = signal<ReadonlySet<string>>(new Set());
  private readonly inspected = signal<ReadonlySet<string>>(new Set());
  private readonly focused = signal<string | null>(null);
  protected readonly arrivals = signal<ReadonlySet<string>>(new Set());
  private previousIds: ReadonlySet<string> | undefined;
  private previousLast: string | undefined;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly replyId = computed(() => this.answerId() ?? "$answer");
  private readonly ordered = computed<readonly WorkStep[]>(() => {
    if (!this.answer()?.trim() && !this.answerTemplate()) return this.steps();
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
  readonly rows = computed(() =>
    workTimelineRows(
      this.ordered(),
      this.live(),
      this.maxVisible(),
      this.expanded(),
    ),
  );
  private readonly pinned = computed(
    () =>
      new Set([
        ...this.inspected(),
        ...(this.focused() ? [this.focused()!] : []),
      ]),
  );
  readonly prose = isProse;
  readonly icon = stepIcon;
  readonly verb = (step: WorkStep): string =>
    stepVerb(step, step.status === "running");
  readonly duration = formatDuration;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["expanded"]?.previousValue === true && !this.expanded()) {
      this.openGroups.set(new Set());
      this.inspected.set(new Set());
      this.reportInspection();
    }
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
      this.rows().flatMap((row) => (row.section ? [row.section.id] : [])),
    );
    this.openGroups.update(
      (current) => new Set([...current].filter((id) => groups.has(id))),
    );
    if (previousInspection !== this.inspected().size + this.openGroups().size)
      this.reportInspection();
  }
  protected visible(row: WorkTimelineRow): boolean {
    if (
      isProse(row.step) ||
      isUnfinishedWork(row.step) ||
      this.pinned().has(row.step.id)
    )
      return true;
    if (row.section && this.openGroups().has(row.section.id)) return true;
    return this.expanded() && !row.section?.folded.has(row.step.id);
  }
  protected groupVisible(row: WorkTimelineRow): boolean {
    return (
      !!row.section &&
      row.section.id === row.step.id &&
      row.section.folded.size > 0
    );
  }
  protected groupOpen(row: WorkTimelineRow): boolean {
    return !!row.section && this.openGroups().has(row.section.id);
  }
  toggleGroup(id: string): void {
    const section = this.rows().find((row) => row.section?.id === id)?.section;
    if (!section) return;
    const wasOpen = this.openGroups().has(id);
    this.openGroups.update((current) => {
      const next = new Set(current);
      if (wasOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (wasOpen) {
      const ids = new Set(section.items.map((step) => step.id));
      this.inspected.update(
        (current) => new Set([...current].filter((key) => !ids.has(key))),
      );
    }
    this.reportInspection();
  }
  /** The turn's work line is an explicit request to reveal or fold every section. */
  setAllOpen(open: boolean): void {
    this.openGroups.set(
      open
        ? new Set(
            this.rows().flatMap((row) => (row.section ? [row.section.id] : [])),
          )
        : new Set(),
    );
    if (!open) this.inspected.set(new Set());
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
    if (groupControl) this.focused.set(null);
    this.reportInspection();
  }
  private reportInspection(): void {
    this.inspectionChanged.emit(
      this.inspected().size > 0 ||
        this.focused() !== null ||
        this.openGroups().size > 0,
    );
  }
}
