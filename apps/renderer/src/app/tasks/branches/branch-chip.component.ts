import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IconComponent } from '../../ui';
@Component({
  selector: 'ex-branch-chip',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './branch-chip.component.html',
  styleUrl: './branch-chip.component.css',
})
export class BranchChipComponent {
  readonly name = input.required<string>();
  readonly base = input<string>();
  readonly compact = input(false);
  readonly copied = input(false);
  readonly canRename = input(true);
  readonly renameRequested = output<string>();
  readonly copyRequested = output<string>();
}
