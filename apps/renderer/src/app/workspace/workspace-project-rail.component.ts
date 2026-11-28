import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ProjectRailComponent } from '../tasks';
import { WorkspaceStore } from './workspace.store';

@Component({
  selector: 'ex-workspace-project-rail',
  imports: [ProjectRailComponent],
  template: `<ex-project-rail [projects]="store.projects()" [activeId]="store.activeProject()" [all]="store.counts()" (selectProject)="store.selectProject($event)" (addProject)="store.openNewProject($event)" />`,
  styles: `:host { display: block; height: 100%; }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceProjectRailComponent { protected readonly store = inject(WorkspaceStore); }
