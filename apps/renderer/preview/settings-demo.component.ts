import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { AppShellComponent } from '../src/app/shell/app-shell.component';
import { ButtonComponent } from '../src/app/ui/button/button.component';
import { IconComponent } from '../src/app/ui/icon/icon.component';
import { ProjectMarkComponent } from '../src/app/tasks/projects/project-mark.component';
import { ProjectRailComponent } from '../src/app/tasks/projects/project-rail.component';
import { TaskListComponent } from '../src/app/tasks/outline/task-list.component';
import { TaskHeaderComponent } from '../src/app/tasks/lifecycle/task-header.component';
import { ProjectSettingsComponent } from '../src/app/projects/project-settings/project-settings.component';
import type { FolderEntry, FolderProvider } from '../src/app/projects/project.models';
import type { ProjectPreferences, ProjectRepository, ProjectSettingsProject, ProjectSettingsSection, RepositorySettingsChange } from '../src/app/projects/project-settings/project-settings.models';
import type { Project, TaskOutline } from '../src/app/tasks/task.models';

const FOLDERS: readonly FolderEntry[] = [
  {path: '~/code/', dir: true}, {path: '~/code/shared-ui', git: 'main · 412 commits'},
  {path: '~/code/shipping-rates', git: 'main · 88 commits'}, {path: '~/code/sheets', git: null},
];

@Component({ selector: 'ex-settings-demo', imports: [AppShellComponent, ButtonComponent, IconComponent, ProjectMarkComponent, ProjectRailComponent, TaskListComponent, TaskHeaderComponent, ProjectSettingsComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-demo.component.html', styleUrl: './settings-demo.component.css' })
export class SettingsDemoComponent {
  readonly project = signal<ProjectSettingsProject>({ id: 'co', name: 'Checkout', initials: 'CO', hue: 'ocean', look: 'letters' });
  readonly repos = signal<readonly ProjectRepository[]>([
    {id: 'api', name: 'payments-api', short: 'api', path: '~/code/payments-api', base: 'main', setup: 'pnpm install', check: 'pnpm test', tasks: 2, sync: 'synced 4m ago', branches: ['main', 'develop', 'release/october']},
    {id: 'web', name: 'storefront-web', short: 'web', path: '~/code/storefront-web', base: 'main', setup: 'pnpm install', check: 'pnpm test && pnpm lint', tasks: 1, sync: 'synced 4m ago', branches: ['main', 'develop']},
    {id: 'notif', name: 'customer-notifications-service', path: '~/code/customer-notifications-service', base: 'develop', setup: 'make deps', check: 'make test', tasks: 1, sync: '2 behind origin', branches: ['develop', 'main']},
  ]);
  readonly preferences = signal<ProjectPreferences>({ prefix: 'leo/', helpers: 'auto', defaultPreset: 'deep', gitPreset: 'git' });
  readonly presets = [{id: 'deep', label: 'Deep work', mark: 'Cl', detail: 'Opus 5.5 · High'}, {id: 'git', label: 'Git helper', mark: 'Cl', detail: 'Sonnet 5.5 · Medium'}];
  readonly open = signal(true);
  readonly section = signal<ProjectSettingsSection>('repos');
  readonly openRepo = signal<string | null>('web');
  readonly adding = signal(false);
  readonly folderState = signal<'ready' | 'loading' | 'empty' | 'error'>('ready');
  readonly note = signal('Open Project settings to configure this project.');
  readonly railProjects = computed<readonly Project[]>(() => [{id: 'co', ...this.project()}, {id: 'ds', name: 'Docs site', initials: 'DS', hue: 'steel'}]);
  readonly tasks = computed<readonly TaskOutline[]>(() => [
    {id: 't1', title: 'Refund button on the order page', repo: this.repos()[1], stage: 'active', sessions: [{id: 's1', title: 'Wire the endpoint', status: 'running', meta: '3m'}]},
    {id: 't2', title: 'Fix flaky checkout test', repo: this.repos()[0], stage: 'active', sessions: [{id: 's3', title: 'Reproduce flake locally', status: 'attention', meta: 'asks'}]},
    {id: 't3', title: 'Send the refund email', repo: this.repos()[2], stage: 'active', sessions: [{id: 's4', title: 'Template and copy', status: 'running', meta: '1m'}]},
  ]);
  readonly listFolders: FolderProvider = (query, signal) => {
    if (this.folderState() === 'error') return Promise.reject(new Error('Preview folder listing failure'));
    if (this.folderState() === 'empty') return [];
    if (this.folderState() === 'loading') return new Promise(resolve => signal.addEventListener('abort', () => resolve([]), {once: true}));
    return FOLDERS.filter(folder => folder.path.startsWith(query) && folder.path !== query);
  };

  show(section: ProjectSettingsSection = 'general', adding = false): void {
    this.section.set(section); this.adding.set(adding); this.open.set(true);
  }
  changeProject(patch: Partial<ProjectSettingsProject>): void {
    this.project.update(project => ({...project, ...patch, ...(patch.look ? patch.look === 'emoji' ? {emoji: '🛒', icon: undefined, initials: undefined} : patch.look === 'icon' ? {icon: 'repo', emoji: undefined, initials: undefined} : {initials: 'CO', emoji: undefined, icon: undefined} : {})}));
  }
  changeRepository(change: RepositorySettingsChange): void {
    this.repos.update(repos => repos.map(repo => repo.id === change.repo.id ? {...repo, ...change.patch} : repo));
  }
  changePreferences(patch: ProjectPreferences): void { this.preferences.update(current => ({...current, ...patch})); }
  addRepository(entry: FolderEntry): void {
    const name = entry.path.split('/').filter(Boolean).at(-1) ?? 'repository';
    this.repos.update(repos => [...repos, {id: `added-${repos.length}`, name, path: entry.path, base: 'main', tasks: 0}]);
    this.adding.set(false);
  }
  removeRepository(repo: ProjectRepository): void { this.repos.update(repos => repos.filter(item => item.id !== repo.id)); }
  archive(): void { this.open.set(false); this.note.set(`Archived ${this.project().name}. Its tasks stay, read-only.`); }
  deleted(): void { this.open.set(false); this.note.set(`Deleted ${this.project().name} from Elevenex. Its repositories stay on dev-box.`); }
}
