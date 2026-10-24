import { CdkMenuModule } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { ProjectMarkComponent } from '../tasks/projects/project-mark.component';
import type { ProjectMark } from '../tasks/task.models';

export type ProjectMenuAction = 'settings' | 'add-repository' | 'closed-tasks' | 'archive' | 'delete';
/** Render inside the owner's CDK menu trigger template; CDK supplies overlay,
 * arrow keys, typeahead, Escape and focus restoration at window level. */
@Component({
  selector: 'ex-project-menu',
  imports: [CdkMenuModule, IconComponent, KbdComponent, ProjectMarkComponent],
  templateUrl: './project-menu.component.html',
  styleUrl: './project-menu.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectMenuComponent {
  readonly project = input.required<ProjectMark>();
  readonly repoCount = input(1);
  readonly machine = input('');
  readonly closed = input<number>();
  readonly disabled = input(false);
  readonly action = output<ProjectMenuAction>();
  readonly settingsRequested = output<void>();
  readonly addRepositoryRequested = output<void>();
  readonly closedTasksRequested = output<void>();
  readonly archiveRequested = output<void>();
  readonly deleteRequested = output<void>();
  protected readonly items: readonly { icon: string; label: string; action: ProjectMenuAction }[] = [
    { icon: 'grid', label: 'Project settings', action: 'settings' },
    { icon: 'repo', label: 'Add a repository…', action: 'add-repository' },
    { icon: 'archive', label: 'Closed tasks', action: 'closed-tasks' },
    { icon: 'layers', label: 'Archive project', action: 'archive' },
    { icon: 'trash', label: 'Delete project…', action: 'delete' },
  ];
  protected trigger(action: ProjectMenuAction): void {
    if (this.disabled()) return;
    this.action.emit(action);
    switch (action) {
      case 'settings': this.settingsRequested.emit(); break;
      case 'add-repository': this.addRepositoryRequested.emit(); break;
      case 'closed-tasks': this.closedTasksRequested.emit(); break;
      case 'archive': this.archiveRequested.emit(); break;
      case 'delete': this.deleteRequested.emit(); break;
    }
  }
}
