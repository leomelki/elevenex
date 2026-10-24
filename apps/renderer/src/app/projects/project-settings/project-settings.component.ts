import { A11yModule } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { ProjectMarkComponent } from '../../tasks/projects/project-mark.component';
import { ButtonComponent } from '../../ui/button/button.component';
import { IconComponent } from '../../ui/icon/icon.component';
import { SegmentedComponent } from '../../ui/controls/segmented.component';
import { SwitchComponent } from '../../ui/controls/switch.component';
import { ModalLayerComponent } from '../../ui/sheet/modal-layer.component';
import { SheetComponent } from '../../ui/sheet/sheet.component';
import { SheetSectionDirective } from '../../ui/sheet/sheet-section.directive';
import { SetGroupComponent, SetRowComponent, SetFieldComponent, SetChoiceComponent, type SettingChoice } from '../../ui/sheet/settings-controls.component';
import { DeleteProjectComponent } from '../delete-project/delete-project.component';
import { PROJECT_HUES, type FolderEntry, type FolderProvider } from '../project.models';
import { AddProjectRepositoryComponent } from './add-project-repository.component';
import { ProjectRepositoryComponent } from './project-repository.component';
import type { ProjectPreferences, ProjectRepository, ProjectSettingsProject, ProjectSettingsSection, RepositorySettingsChange } from './project-settings.models';

@Component({
  selector: 'ex-project-settings',
  imports: [A11yModule, ProjectMarkComponent, ButtonComponent, IconComponent, SegmentedComponent, SwitchComponent, ModalLayerComponent, SheetComponent, SheetSectionDirective, SetGroupComponent, SetRowComponent, SetFieldComponent, SetChoiceComponent, DeleteProjectComponent, AddProjectRepositoryComponent, ProjectRepositoryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './project-settings.component.html', styleUrl: './project-settings.component.css',
})
export class ProjectSettingsComponent {
  readonly open = input(false);
  readonly id = input('project-settings');
  readonly project = input.required<ProjectSettingsProject>();
  /** A bounded owner-supplied window of repositories. */
  readonly repos = input<readonly ProjectRepository[]>([]);
  readonly repoCount = input<number>();
  readonly machine = input<string>();
  readonly section = input<ProjectSettingsSection>('general');
  readonly openRepo = input<string | null>();
  readonly adding = input<boolean>();
  readonly addQuery = input('~/code/');
  readonly listFolders = input<FolderProvider>();
  readonly preferences = input<ProjectPreferences>({});
  readonly presets = input<readonly SettingChoice[]>([]);
  readonly since = input<string>();
  readonly tasks = input(0);
  readonly sessions = input(0);
  readonly running = input(0);
  readonly closed = output<void>();
  readonly projectChanged = output<Partial<ProjectSettingsProject>>();
  readonly preferencesChanged = output<ProjectPreferences>();
  readonly repoChanged = output<RepositorySettingsChange>();
  readonly repoAdded = output<FolderEntry>();
  readonly repoRemoved = output<ProjectRepository>();
  readonly moreReposRequested = output<void>();
  readonly archiveRequested = output<void>();
  readonly deleteConfirmed = output<void>();
  private readonly context = computed(() => ({
    open: this.open(), project: this.project().id ?? this.id(), section: this.section(),
    repo: this.openRepo(), adding: this.adding(),
  }), { equal: (previous, current) => previous.open === current.open && previous.project === current.project
    && previous.section === current.section && previous.repo === current.repo && previous.adding === current.adding });
  protected readonly expandedRepo = linkedSignal({ source: this.context, computation: (context, previous): string | null => {
    if (previous?.source.project !== context.project) return context.repo ?? null;
    if (!context.open) return previous.value;
    return context.repo !== undefined ? context.repo : previous.value;
  } });
  protected readonly isAdding = linkedSignal({ source: this.context, computation: (context, previous): boolean => {
    if (previous?.source.project !== context.project) return context.adding ?? false;
    if (!context.open) return previous.value;
    return context.adding !== undefined ? context.adding : previous.value;
  } });
  protected readonly deleting = linkedSignal({ source: this.context, computation: () => false });
  protected readonly removing = signal<ProjectRepository | null>(null);
  protected readonly removeOpen = linkedSignal({ source: this.context, computation: () => false });
  protected readonly faceKey = computed(() => `${this.project().hue ?? ''}/${this.project().initials ?? ''}/${this.project().emoji ?? ''}/${this.project().icon ?? ''}`);
  protected readonly hues = PROJECT_HUES;
  protected readonly visibleRepos = computed(() => this.repos().slice(0, 100));
  protected readonly totalRepos = computed(() => this.repoCount() ?? this.repos().length);
  protected readonly description = computed(() => [
    `${this.totalRepos()} ${this.totalRepos() === 1 ? 'repository' : 'repositories'}`, this.machine(), this.since()?.replace(/^Created/, 'created'),
  ].filter(Boolean).join(' · '));
  protected readonly helperNote = computed(() => this.preferences().helpers === 'ask'
    ? 'Elevenex asks first: the toast has Start.'
    : this.preferences().helpers === 'never' ? 'The git button opens the conflicts in Changes; nothing starts on its own.'
    : 'When a merge or a sync needs judgement, Elevenex starts one session for it and tells you.');
  protected readonly mergeOptions: readonly SettingChoice[] = [
    { id: 'squash', label: 'Squash and merge' }, { id: 'merge', label: 'Merge commit' }, { id: 'rebase', label: 'Rebase and merge' },
  ];
  protected readonly faceOptions = [{id: 'letters', label: 'Letters'}, {id: 'emoji', label: 'Emoji'}, {id: 'icon', label: 'Icon'}];
  protected readonly taskOptions = [{id: 'active', label: 'In progress'}, {id: 'planned', label: 'Planned'}];
  protected readonly helperOptions = [{id: 'auto', label: 'Automatically'}, {id: 'ask', label: 'Ask first'}, {id: 'never', label: 'Never'}];

  protected changeLook(value: string): void { if (value === 'letters' || value === 'emoji' || value === 'icon') this.projectChanged.emit({look: value}); }
  protected changeTaskStage(value: string): void { if (value === 'active' || value === 'planned') this.preferencesChanged.emit({newTasks: value}); }
  protected changeHelpers(value: string): void { if (value === 'auto' || value === 'ask' || value === 'never') this.preferencesChanged.emit({helpers: value}); }
  protected changeMerge(value: string): void { if (value === 'squash' || value === 'merge' || value === 'rebase') this.preferencesChanged.emit({subtaskMerge: value}); }
  protected add(entry: FolderEntry): void { this.isAdding.set(false); this.repoAdded.emit(entry); }
  protected requestRemove(repo: ProjectRepository): void { this.removing.set(repo); this.removeOpen.set(true); }
  protected confirmRemove(): void { const repo = this.removing(); this.removeOpen.set(false); if (repo) this.repoRemoved.emit(repo); }
  protected confirmDelete(): void { this.deleting.set(false); this.deleteConfirmed.emit(); }
  protected archive(): void { this.deleting.set(false); this.archiveRequested.emit(); }
}
