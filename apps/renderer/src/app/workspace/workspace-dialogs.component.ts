import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, computed, inject, viewChild } from '@angular/core';
import { DeleteProjectComponent, NewProjectComponent } from '../projects';
import { NewTaskComponent } from '../tasks';
import { ButtonComponent, DropdownMenuComponent, DropdownRadioComponent, ModalLayerComponent, ToastComponent } from '../ui';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceProjectSettingsComponent } from './workspace-project-settings.component';

@Component({
  selector: 'ex-workspace-dialogs',
  imports: [NewProjectComponent, NewTaskComponent, ModalLayerComponent, WorkspaceProjectSettingsComponent, DropdownMenuComponent, DropdownRadioComponent, DeleteProjectComponent, ToastComponent, ButtonComponent],
  templateUrl: './workspace-dialogs.component.html',
  styleUrl: './workspace-dialogs.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceDialogsComponent {
  protected readonly store = inject(WorkspaceStore);
  protected readonly projectOptions = computed(() => this.store.projects().map(project => ({ id: project.id, label: project.name })));
  private readonly deleteProgress = viewChild<ElementRef<HTMLElement>>('deleteProgress');
  private readonly dialogError = viewChild<ElementRef<HTMLElement>>('dialogError');

  constructor() {
    afterRenderEffect(() => {
      if (this.store.dialog() !== 'delete' || !this.store.dialogOpen()) return;
      // Making the confirmation inert blurs its button. Keep keyboard focus
      // inside the modal while cleanup runs and when a failure is announced.
      const target = this.store.busy() ? this.deleteProgress() : this.dialogError();
      target?.nativeElement.focus({ preventScroll: true });
    });
  }

  protected addRepository(): void {
    const project = this.store.draftProject();
    if (project) { this.store.activeProject.set(String(project.id)); void this.store.openSettings(true); }
  }
}
