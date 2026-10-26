import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NewProjectComponent } from '../../projects';
import { ProjectRailComponent } from '../../tasks';
import { ButtonComponent } from '../../ui';
import type { Machine } from '../index';

/** Machine content boundary. Project/task features can replace this landing
 * without owning the machine connection, title island or launch transition.
 */
@Component({
  selector: 'ex-machine-workspace',
  imports: [NewProjectComponent, ProjectRailComponent, ButtonComponent],
  templateUrl: './machine-workspace.component.html',
  styleUrl: './machine-workspace.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineWorkspaceComponent {
  readonly machine = input.required<Machine>();
  readonly active = input(false);
  readonly changeRequested = output<void>();
}
