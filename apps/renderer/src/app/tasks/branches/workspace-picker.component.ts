import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { DropdownMenuComponent, DropdownItemComponent, DropdownRadioComponent, IconComponent } from '../../ui';
import type { Workspace } from '../task.models';
@Component({
  selector: 'ex-workspace-picker',
  imports: [CdkMenuTrigger, DropdownMenuComponent, DropdownItemComponent, DropdownRadioComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-picker.component.html',
  styleUrl: './workspace-picker.component.css',
})
export class WorkspacePickerComponent {
  readonly value = input('auto');
  readonly items = input<readonly Workspace[]>([]);
  readonly valueChange = output<string>();
  readonly newWorkspace = output<void>();
  readonly manageWorkspaces = output<void>();
  protected readonly free = computed(() =>
    this.items().filter((item) => item.state === 'free'),
  );
  protected readonly note = computed(() => {
    const first = this.free()[0];
    return first
      ? `reuses ${first.name}${first.note ? ', ' + first.note : ''}`
      : 'creates a new one';
  });
}
