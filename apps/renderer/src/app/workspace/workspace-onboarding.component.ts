import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NewProjectComponent, type CreateProjectIntent } from '../projects';
import { WorkspaceStore } from './workspace.store';

@Component({
  selector: 'ex-workspace-onboarding',
  imports: [NewProjectComponent],
  template: `<ex-new-project [machine]="store.machine()?.name ?? 'this machine'" [listFolders]="store.folderProvider()" [checkName]="store.projectNameProvider()" [active]="!!store.scopeId() && !launching()" [busy]="store.busy()" [disabled]="!store.scopeId()" [error]="store.error()" [recoveryRequired]="store.mutationUncertain()" [recovering]="store.loading()" (recoveryRequested)="store.refresh()" [launching]="launching()" [autoFocus]="true" (create)="create($event)" />`,
  styles: `:host { display: block; width: min(540px, 100%); }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceOnboardingComponent {
  protected readonly store = inject(WorkspaceStore);
  readonly launching = input(false);
  readonly projectSubmitted = output<CreateProjectIntent>();
  protected create(intent: CreateProjectIntent): void { this.projectSubmitted.emit(intent); void this.store.createProject(intent); }
}
