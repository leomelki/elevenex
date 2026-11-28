import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FolderSuggestionsComponent, ProjectAppearanceComponent } from '../projects';
import { ButtonComponent, SheetComponent, SheetSectionDirective, SetGroupComponent, SetRowComponent, SetValueComponent, SetChoiceComponent } from '../ui';
import { SidebarPreferencesService } from './sidebar-preferences.service';
import { WorkspaceStore } from './workspace.store';

/** Project settings and the device-local sidebar preference use separate owners. */
@Component({
  selector: 'ex-workspace-project-settings',
  imports: [ProjectAppearanceComponent, FolderSuggestionsComponent, ButtonComponent, SheetComponent, SheetSectionDirective, SetGroupComponent, SetRowComponent, SetValueComponent, SetChoiceComponent],
  templateUrl: './workspace-project-settings.component.html',
  styleUrl: './workspace-project-settings.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceProjectSettingsComponent {
  protected readonly preferences = inject(SidebarPreferencesService);
  protected readonly store = inject(WorkspaceStore);
  protected readonly appearance = computed(() => ({ name: this.store.draftProject()?.name ?? '', ...this.store.draftProject()?.appearance }));
}
