import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { IconComponent } from '../../ui';
import type { Workspace } from '../task.models';
@Component({
  selector: 'ex-workspace-picker',
  imports: [CdkMenuModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-picker.component.html',
  styleUrls: ['../tasks-menu.css', './workspace-picker.component.css'],
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
