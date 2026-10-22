import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { IconComponent, KbdComponent } from '../../ui';
import type { BranchInfo, BranchRow } from '../task.models';
import {
  branchHighlights,
  branchItems,
  selectableBranch,
} from './branch-options';
@Component({
  selector: 'ex-branch-picker',
  imports: [IconComponent, KbdComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './branch-picker.component.html',
  styleUrl: './branch-picker.component.css',
})
export class BranchPickerComponent {
  readonly query = input('');
  readonly branches = input<readonly BranchInfo[]>([]);
  readonly items = input<readonly BranchRow[]>();
  readonly allowCreate = input(false);
  readonly base = input<string>();
  readonly highlighted = input(0);
  readonly label = input('Branches');
  readonly listId = input(`branch-options-${crypto.randomUUID()}`);
  readonly pick = output<BranchRow>();
  protected readonly rows = computed(
    () =>
      this.items() ??
      branchItems(this.query(), this.branches(), this.allowCreate()),
  );
  protected readonly highlights = branchHighlights;
  protected readonly selectable = selectableBranch;
  protected metadata(row: BranchRow): string {
    return row.task
      ? 'In use · ' + row.task
      : row.kind === 'create'
        ? this.base()
          ? 'from ' + this.base()
          : ''
        : [row.remote ? 'remote' : '', row.when].filter(Boolean).join(' · ');
  }
  protected choose(row: BranchRow): void {
    if (selectableBranch(row)) this.pick.emit(row);
  }
}
