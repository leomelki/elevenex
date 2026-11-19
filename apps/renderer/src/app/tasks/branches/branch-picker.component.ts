import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import {
  IconComponent,
  KbdComponent,
  FittedHighlightDirective,
} from "../../ui";
import type { BranchInfo, BranchRow } from "../task.models";
import {
  branchHighlights,
  branchItems,
  branchRef,
  selectableBranch,
} from "./branch-options";
@Component({
  selector: "ex-branch-picker",
  imports: [FittedHighlightDirective, IconComponent, KbdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./branch-picker.component.html",
  styleUrl: "./branch-picker.component.css",
})
export class BranchPickerComponent {
  readonly query = input("");
  readonly branches = input<readonly BranchInfo[]>([]);
  readonly items = input<readonly BranchRow[]>();
  readonly allowCreate = input(false);
  readonly allowHeld = input(false);
  readonly disabled = input(false);
  readonly base = input<string>();
  readonly highlighted = input(0);
  readonly label = input("Branches");
  readonly listId = input(`branch-options-${crypto.randomUUID()}`);
  readonly pick = output<BranchRow>();
  protected readonly rows = computed(
    () =>
      this.items() ??
      branchItems(this.query(), this.branches(), this.allowCreate()),
  );
  protected readonly highlightKey = computed(
    () =>
      this.highlighted() +
      ":" +
      this.rows()
        .map((row) => row.kind + ":" + branchRef(row))
        .join("\n"),
  );
  protected readonly highlights = branchHighlights;
  protected readonly ref = branchRef;
  protected selectable(row: BranchRow): boolean {
    return !this.disabled() && selectableBranch(row, this.allowHeld());
  }
  protected metadata(row: BranchRow): string {
    if (row.kind === "create") return this.base() ? "from " + this.base() : "";
    const task = row.task && (this.allowHeld() ? "Task · " : "In use · ") + row.task;
    return [row.remote ? "remote" : "", task || row.when].filter(Boolean).join(" · ");
  }
  protected choose(row: BranchRow): void {
    if (this.selectable(row)) this.pick.emit(row);
  }
}
