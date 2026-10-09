import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NavigationWorkspace } from '@/shared/models/navigation-tree.model';

@Component({
  selector: 'app-task-navigation-label',
  templateUrl: './task-navigation-label.component.html',
  host: { class: 'block min-w-0 flex-1' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskNavigationLabelComponent {
  readonly workspace = input.required<NavigationWorkspace>();
}
