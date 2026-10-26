import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";
import { FoldComponent, IconComponent } from "../../ui";
import type { WorkStep } from "../conversation.models";
import { MarkdownComponent } from "../markdown/markdown.component";
import { ToolStepComponent } from "./tool-step.component";
import {
  formatDuration,
  groupWorkSteps,
  isProse,
  stepIcon,
  stepVerb,
} from "./work-summary";
@Component({
  selector: "ex-work-timeline",
  imports: [FoldComponent, IconComponent, MarkdownComponent, ToolStepComponent],
  templateUrl: "./work-timeline.component.html",
  styleUrl: "./work-timeline.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkTimelineComponent {
  readonly steps = input<readonly WorkStep[]>([]);
  readonly live = input(false);
  readonly maxVisible = input(4);
  readonly earlierOpen = signal(false);
  readonly openGroups = signal<ReadonlySet<string>>(new Set());
  readonly entries = computed(() => groupWorkSteps(this.steps()));
  readonly condensed = computed(() => {
    const entries = this.entries();
    if (!this.live() || this.earlierOpen())
      return { visible: entries, hidden: 0 };
    const recent = entries
      .filter((entry) => entry.kind !== "say" && entry.kind !== "note")
      .slice(-Math.max(1, this.maxVisible()));
    const latestMessage = [...entries]
      .reverse()
      .find((entry) => entry.kind === "say" || entry.kind === "note");
    const keep = new Set([
      ...recent.map((entry) => entry.id),
      ...(latestMessage ? [latestMessage.id] : []),
    ]);
    const hidden = entries
      .filter((entry) => !keep.has(entry.id))
      .reduce(
        (count, entry) =>
          count +
          (entry.kind === "group"
            ? entry.items.length
            : entry.kind === "say" || entry.kind === "note"
              ? 0
              : 1),
        0,
      );
    return hidden > 1
      ? { visible: entries.filter((entry) => keep.has(entry.id)), hidden }
      : { visible: entries, hidden: 0 };
  });
  readonly hiddenCount = computed(() => this.condensed().hidden);
  readonly visible = computed(() => this.condensed().visible);
  readonly prose = isProse;
  readonly verb = stepVerb;
  readonly icon = stepIcon;
  readonly duration = formatDuration;
  toggleGroup(id: string): void {
    this.openGroups.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
}
