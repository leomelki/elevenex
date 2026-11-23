import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  type OnChanges,
  type TemplateRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
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
import type { ToolContentRequest, ToolDetailsProvider, ToolImageProvider } from "../tool-presentation";
import { MarkdownComponent } from "../markdown/markdown.component";
import { MarkdownMediaComponent } from "../markdown/markdown-media.component";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import { NowLineComponent } from "./now-line.component";
import { ToolStepComponent } from "./tool-step.component";
import {
  isUnfinishedWork,
  workTimelineRows,
  type WorkSection,
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
    MarkdownMediaComponent,
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
  readonly revealWork = input(false);
  readonly workReady = input(true);
  readonly maxVisible = input(5);
  readonly answer = input<string>();
  readonly answerId = input<string>();
  readonly answerBeforeStepId = input<string>();
  readonly answerTemplate = input<TemplateRef<unknown>>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly inspectTool = input<ToolDetailsProvider>();
  readonly toolImages = input<ToolImageProvider>();
  readonly openFile = output<string>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
  readonly contentRequested = output<ToolContentRequest>();
  readonly layoutChanging = output<HTMLElement>();
  readonly inspectionChanged = output<boolean>();
  readonly openGroups = signal<ReadonlySet<string>>(new Set());
  protected readonly openTools = signal<ReadonlySet<string>>(new Set());
  private readonly inspected = signal<ReadonlySet<string>>(new Set());
  private readonly focused = signal<string | null>(null);
  protected readonly arrivals = signal<ReadonlySet<string>>(new Set());
  protected readonly hydrated = signal<ReadonlySet<string>>(new Set());
  private previousIds: ReadonlySet<string> | undefined;
  private previousLast: string | undefined;
  private previousMessage: string | undefined;
  private runningTools = new Set<string>();
  private readonly settledVisible = signal<ReadonlySet<string>>(new Set());
  private previousSections = new Map<string, readonly string[]>();
  private reportedInspection = false;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
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
      this.settledVisible(),
    ),
  );
  protected readonly mountedWorkRows = linkedSignal({
    source: () => this.revealWork() ? this.rows() : undefined,
    computation: (rows, previous): ReadonlySet<string> => {
      const retained = previous?.value;
      return new Set(rows?.filter(row => !isProse(row.step) &&
        (retained?.has(row.step.id) || this.visible(row))).map(row => row.step.id));
    },
  });
  protected readonly renderedRows = computed(() => {
    const rows = this.rows();
    if (!this.revealWork()) return rows;
    const mounted = this.mountedWorkRows();
    // Retain group controls and rows that have entered a fold. An unopened
    // group in a saved timeline needs no hidden row shells.
    return rows.filter(row => isProse(row.step) || mounted.has(row.step.id) ||
      (row.section?.id === row.step.id && row.section.folded.size > 0));
  });
  private readonly lastMessageId = computed(() => {
    const steps = this.ordered();
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]!;
      if (step.kind === "say" && (
        step.text?.trim() ||
        (step.id === this.replyId() && this.answer() === undefined && this.answerTemplate())
      ))
        return step.id;
    }
    return undefined;
  });
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

  ngOnChanges(): void {
    const steps = this.ordered();
    this.keepSettledTools(steps);
    const previousLastIndex = steps.findIndex(
      (step) => step.id === this.previousLast,
    );
    const ids = new Set(steps.map((step) => step.id));
    if (this.revealWork() && this.expanded() && this.previousIds) {
      this.hydrated.set(new Set(this.rows()
        .filter(row => !this.previousIds?.has(row.step.id) &&
          (this.visible(row) || this.groupVisible(row)))
        .map(row => row.step.id)));
    }
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
    // When a saved turn releases its rows, retain only the reader's choices
    // and the section identities needed when those rows are restored.
    if (!this.workReady()) return;
    const retain = (current: ReadonlySet<string>) => {
      const next = new Set([...current].filter(id => ids.has(id)));
      return next.size === current.size ? current : next;
    };
    this.openTools.update(retain);
    this.inspected.update(retain);
    const sections = new Map<string, WorkSection>();
    const byStep = new Map<string, WorkSection>();
    for (const { step, section } of this.rows()) {
      if (!section) continue;
      sections.set(section.id, section);
      byStep.set(step.id, section);
    }
    const active = this.host.nativeElement.ownerDocument.activeElement;
    const focusedGroup = active instanceof HTMLElement && active.matches('.group') &&
      this.host.nativeElement.contains(active)
      ? active.closest<HTMLElement>('[data-work-step]')?.dataset['workStep'] : undefined;
    this.openGroups.update(current => {
      const next = new Set<string>();
      for (const id of current) {
        if (sections.has(id)) next.add(id);
        else {
          // Prepending activity can change the first row of the same section.
          const retained = this.previousSections.get(id)?.find(step => byStep.has(step));
          if (!retained) continue;
          const replacement = byStep.get(retained)!.id;
          next.add(replacement);
          if (id === focusedGroup) this.restoreGroupFocus(active, replacement);
        }
      }
      return next.size === current.size && [...next].every(id => current.has(id)) ? current : next;
    });
    this.previousSections = new Map([...this.openGroups()].flatMap(id => {
      const section = sections.get(id);
      return section ? [[id, section.items.map(step => step.id)]] : [];
    }));
    this.reportInspection();
  }
  private keepSettledTools(steps: readonly WorkStep[]): void {
    let latestMessage: string | undefined;
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]!;
      if (isProse(step) && step.text?.trim()) {
        latestMessage = step.id;
        break;
      }
    }
    const tools = this.live() ? steps.filter(step => !isProse(step) && step.kind !== 'think') : [];
    const limit = this.maxVisible();
    const visible = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 5;
    const previous = this.settledVisible();
    const next = new Set(tools.slice(-visible).filter(step =>
      !isUnfinishedWork(step) && (this.runningTools.has(step.id) ||
        (latestMessage === this.previousMessage && previous.has(step.id))),
    ).map(step => step.id));
    // Commentary can close a section while its last call is still running.
    // Keep that call in place when its receipt arrives, within the live budget.
    if (next.size !== previous.size || [...next].some(id => !previous.has(id)))
      this.settledVisible.set(next);
    this.runningTools = new Set(tools.filter(isUnfinishedWork).map(step => step.id));
    this.previousMessage = latestMessage;
  }
  activeToolIds(): readonly string[] {
    const tools = this.openTools();
    return tools.size ? this.rows().filter(row => row.step.deferredTool && tools.has(row.step.id) && this.visible(row))
      .map(row => row.step.id) : [];
  }
  private restoreGroupFocus(previous: Element | null, id: string): void {
    afterNextRender(() => {
      const host = this.host.nativeElement;
      const document = host.ownerDocument;
      if (previous?.isConnected || document.activeElement !== document.body) return;
      host.querySelector<HTMLButtonElement>(`[data-work-step="${CSS.escape(id)}"] .group`)
        ?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }
  protected visible(row: WorkTimelineRow): boolean {
    // The outer disclosure owns settled activity, including messages and
    // unfinished receipts. Inner tool and section disclosures stay independent.
    if (!this.live() && !this.expanded())
      return row.step.id === (this.answer()?.trim() ? this.replyId() : this.lastMessageId());
    if (!this.expanded() && !isProse(row.step) && !isUnfinishedWork(row.step))
      return false;
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
      (this.live() || this.expanded()) &&
      !!row.section &&
      row.section.id === row.step.id &&
      row.section.folded.size > 0
    );
  }
  protected groupOpen(row: WorkTimelineRow): boolean {
    return !!row.section && this.openGroups().has(row.section.id);
  }
  toggleGroup(id: string, control: HTMLButtonElement): void {
    const section = this.rows().find((row) => row.section?.id === id)?.section;
    if (!section) return;
    this.layoutChanging.emit(control);
    const wasOpen = this.openGroups().has(id);
    this.openGroups.update((current) => {
      const next = new Set(current);
      if (wasOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (wasOpen) {
      this.previousSections.delete(id);
      const ids = new Set(section.items.map((step) => step.id));
      this.inspected.update(
        (current) => new Set([...current].filter((key) => !ids.has(key))),
      );
    } else this.previousSections.set(id, section.items.map(step => step.id));
    this.reportInspection();
  }
  protected toolExpanded(id: string, expanded: boolean): void {
    const update = (current: ReadonlySet<string>) => {
      const next = new Set(current);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    };
    this.openTools.update(update);
    this.inspected.update(update);
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
    const focused = this.focused();
    // The latest reply stays available with Worked closed. Its controls only
    // need to pin the timeline if a later reply turns it into commentary.
    const inspecting =
      this.inspected().size > 0 ||
      (focused !== null && focused !== this.lastMessageId()) ||
      this.openGroups().size > 0;
    if (inspecting === this.reportedInspection) return;
    this.reportedInspection = inspecting;
    this.inspectionChanged.emit(inspecting);
  }
}
