import { A11yModule } from '@angular/cdk/a11y';
import { CdkMenuModule } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { ButtonComponent, IconComponent } from '../src/app/ui';
import { ModalLayerComponent } from '../src/app/ui/sheet/modal-layer.component';
import { ProjectMarkComponent } from '../src/app/tasks/projects/project-mark.component';
import { ProjectRailComponent } from '../src/app/tasks/projects/project-rail.component';
import { NewTaskComponent } from '../src/app/tasks/branches/new-task.component';
import { NewProjectComponent, ProjectMenuComponent, jumpHome, projectFace, settleMark, type CreateProjectIntent, type FolderEntry, type FolderProvider, type NewProjectDraft, type NewProjectRepo, type NewProjectResult, type ProjectMenuAction } from '../src/app/projects';
import { IslandNameComponent, TitleBarComponent, TitleIslandComponent, type Machine } from '../src/app/machines';

const REPOS: readonly NewProjectRepo[] = [
  { id: '~/code/payments-api', name: 'payments-api', path: '~/code/payments-api', branch: 'main' },
  { id: '~/code/storefront-web', name: 'storefront-web', path: '~/code/storefront-web', branch: 'main' },
];
const FOLDERS: Readonly<Record<string, readonly string[]>> = { '~/': ['code', 'src', 'notes'], '~/code/': ['checkout-e2e', 'payments-api', 'payroll-tools', 'pantry', 'storefront-web'], '~/src/': ['docs-site', 'infra'] };
const GIT: Readonly<Record<string, readonly [string, string]>> = { 'payments-api': ['main', '214 commits'], 'payroll-tools': ['main', '38 commits'], 'storefront-web': ['main', '1,204 commits'], 'checkout-e2e': ['main', '57 commits'], 'docs-site': ['main', '96 commits'], infra: ['trunk', '512 commits'] };

@Component({
  selector: 'ex-project-creation-demo',
  imports: [A11yModule, CdkMenuModule, ButtonComponent, IconComponent, ModalLayerComponent, ProjectMarkComponent, ProjectRailComponent, NewTaskComponent, NewProjectComponent, ProjectMenuComponent, TitleBarComponent, TitleIslandComponent, IslandNameComponent],
  templateUrl: './project-creation-demo.component.html',
  styleUrl: './project-creation-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectCreationDemoComponent {
  readonly machine: Machine = { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'live', color: 'ocean' };
  readonly branches = [{ name: 'main', isDefault: true, when: 'today' }, { name: 'leo/refund-webhooks', when: '2d ago' }];
  readonly phase = signal<'form' | 'launch' | 'done'>('form');
  readonly created = signal<NewProjectResult | null>(null);
  readonly formKey = signal(0);
  readonly replayDraft = signal<NewProjectDraft>({ name: '' });
  readonly modalOpen = signal(false);
  readonly modalVersion = signal(0);
  readonly busy = signal(false);
  readonly lastIntent = signal('');
  readonly sourceState = signal<'ready' | 'loading' | 'error' | 'empty'>('ready');
  readonly lookDraft: NewProjectDraft = { name: 'Payments', repos: REPOS, query: '', look: 'icon', icon: 'bolt', hue: 'pine', step: 'look' };
  readonly repoDraft: NewProjectDraft = { name: '', repos: REPOS, query: '' };
  readonly menuProject = { name: 'Checkout', initials: 'CO', hue: 'ocean' } as const;
  readonly face = computed(() => projectFace(this.created() || { name: 'Checkout' }));
  readonly railProjects = computed(() => this.created() ? [{ ...this.face(), id: 'created-project' }] : []);
  readonly listFolders = computed<FolderProvider>(() => {
    const state = this.sourceState();
    return (query, signal) => {
    if (state === 'empty') return [];
    if (state === 'error') return Promise.reject(new Error('Preview folder service unavailable'));
    if (state === 'loading') return new Promise<readonly FolderEntry[]>((resolve) => signal.addEventListener('abort', () => resolve([]), { once: true }));
    return this.folders(query);
    };
  });
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly injector = inject(Injector);
  private animations: Animation[] = [];
  private disposers: (() => void)[] = [];
  private run = 0;

  constructor() { inject(DestroyRef).onDestroy(() => this.stopMotion()); }
  folders(query: string): readonly FolderEntry[] {
    if (/^(git@|https?:\/\/)/.test(query)) {
      const name = query.replace(/\.git$/, '').split(/[/:]/).pop();
      return name && query.length > 14 ? [{ path: `~/code/${name}`, name, clone: query }] : [];
    }
    const split = query.lastIndexOf('/');
    const directory = query.slice(0, split + 1);
    const part = query.slice(split + 1).toLowerCase();
    return (FOLDERS[directory] || []).filter(name => name.startsWith(part)).map(name => ({ path: directory + name, name, git: GIT[name] ? GIT[name].join(' · ') : null, branch: GIT[name]?.[0], dir: !!FOLDERS[directory + name + '/'] }));
  }
  reset(filled = false): void {
    this.stopMotion();
    this.phase.set('form');
    this.created.set(null);
    this.replayDraft.set(filled ? { name: 'Checkout', repos: REPOS, look: 'emoji', emoji: '🛒', hue: 'rust', step: 'look' } : { name: '' });
    this.formKey.update(key => key + 1);
  }
  openModal(): void {
    this.modalVersion.update(version => version + 1);
    this.modalOpen.set(true);
  }
  launch(intent: CreateProjectIntent): void {
    this.stopMotion();
    const run = this.run;
    this.created.set(intent.project);
    this.phase.set('launch');
    afterNextRender(() => {
      if (this.run !== run) return;
      const root = this.frame()?.nativeElement;
      // Launch motion never gates typing. This owner also owns first-run focus;
      // its trap does not restore a previous preview control on card removal.
      root?.querySelector<HTMLInputElement>('ex-new-task input[aria-label="Task name"]')?.focus({ preventScroll: true });
      const from = intent.card.querySelector<HTMLElement>('[data-np="face"] ex-project-mark');
      const to = root?.querySelector<HTMLElement>('[data-project-id="created-project"] ex-project-mark');
      if (!root || !from || !to) { this.phase.set('done'); return; }
      const faceFlight = jumpHome(root, from, to, { landed: element => { if (this.run === run) this.disposers.push(settleMark(root, element, intent.project.hue)); } });
      const name = intent.card.querySelector<HTMLElement>('[data-np="name"]');
      const heading = root.querySelector<HTMLElement>('.side-name');
      if (name && heading) {
        const nameFlight = jumpHome(root, name, heading, { text: intent.project.name, grow: .06, shadow: false, dur: 940, delay: 50, peak: 62, scale: heading.offsetHeight / Math.max(1, name.offsetHeight) });
        if (nameFlight) this.animations.push(nameFlight);
      }
      if (faceFlight) {
        this.animations.push(faceFlight);
        void faceFlight.finished.then(() => { if (this.run === run) this.phase.set('done'); }, () => undefined);
      } else this.phase.set('done');
    }, { injector: this.injector });
  }
  menu(action: ProjectMenuAction): void { this.lastIntent.set(action); if (action === 'add-repository') this.openModal(); }
  onSourceChanged(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (value === 'ready' || value === 'loading' || value === 'error' || value === 'empty') this.sourceState.set(value);
  }
  modalCreated(intent: CreateProjectIntent): void { this.lastIntent.set(`Create project: ${intent.project.name} (${intent.project.repos.length} repositories)`); this.modalOpen.set(false); }
  private stopMotion(): void { this.run++; for (const animation of this.animations) animation.cancel(); this.animations = []; for (const dispose of this.disposers) dispose(); this.disposers = []; }
}
