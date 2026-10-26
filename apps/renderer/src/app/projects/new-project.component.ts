import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, OnInit, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { AutoHeightDirective, ButtonComponent, EaseSwapComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent } from '../ui';
import { ListPresence } from '../ui/motion/list-presence';
import { ProjectMarkComponent } from '../tasks/projects/project-mark.component';
import { FolderSuggestionsComponent } from './folder-suggestions.component';
import { ProjectAppearanceComponent } from './project-appearance.component';
import { folderName, projectFace, projectHue, projectInitials } from './project-face';
import type { CreateProjectIntent, FolderEntry, FolderProvider, NewProjectDraft, NewProjectRepo, NewProjectStep, ProjectAppearance } from './project.models';

@Component({
  selector: 'ex-new-project',
  imports: [AutoHeightDirective, ButtonComponent, EaseSwapComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, ProjectMarkComponent, FolderSuggestionsComponent, ProjectAppearanceComponent],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.launching]': 'launching()', '[attr.inert]': 'active() ? null : ""' },
})
export class NewProjectComponent implements OnInit {
  readonly machine = input('this machine');
  readonly machineIcon = input('server');
  readonly listFolders = input<FolderProvider>();
  /** Initial unfinished interaction state; remount to begin a different draft. */
  readonly draft = input<NewProjectDraft>({ name: '' });
  readonly autoFocus = input(true);
  /** Retain the rendered draft during exit while stopping interaction and folder work. */
  readonly active = input(true);
  readonly cancelable = input(false);
  readonly busy = input(false);
  /** Unavailable integrations can disable a draft without claiming work is in progress. */
  readonly disabled = input(false);
  protected readonly blocked = computed(() => this.busy() || this.disabled());
  /** Conceals only the source face/name while their owner animates copies. */
  readonly launching = input(false);
  readonly create = output<CreateProjectIntent>();
  readonly cancelled = output<void>();
  protected readonly step = signal<NewProjectStep>('repos');
  protected readonly repos = signal<readonly NewProjectRepo[]>([]);
  protected readonly query = signal('~/code/');
  protected readonly appearance = signal<ProjectAppearance>({ name: '', look: 'letters', emoji: '🛒', icon: 'repo' });
  protected readonly face = computed(() => projectFace(this.appearance()));
  protected readonly blankFace = computed(() => (this.appearance().look || 'letters') === 'letters' && !projectInitials(this.appearance().name));
  protected readonly addedPaths = computed(() => this.repos().map(repo => repo.path));
  protected readonly repoSummary = computed(() => this.repos().map(repo => repo.name).join(', '));
  protected readonly canCreate = computed(() => this.repos().length > 0 && !!this.appearance().name.trim() && !this.blocked());
  protected readonly canNext = computed(() => !this.blocked() && (this.step() === 'repos' ? this.repos().length > 0 : this.step() === 'name' ? !!this.appearance().name.trim() : this.canCreate()));
  protected readonly order: readonly NewProjectStep[] = ['repos', 'name', 'look'];
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');
  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');
  private readonly folders = viewChild(FolderSuggestionsComponent);
  private readonly footer = viewChild<ElementRef<HTMLElement>>('footer');
  private named = false;
  protected readonly presence = new ListPresence(this.repos, repo => repo.id, this.root, inject(DestroyRef));

  ngOnInit(): void {
    const draft = this.draft();
    this.repos.set(draft.repos ?? []);
    this.appearance.set({ name: draft.name || draft.repos?.[0]?.name || '', look: draft.look || 'letters', emoji: draft.emoji || '🛒', icon: draft.icon || 'repo', hue: draft.hue });
    this.named = !!draft.name;
    this.query.set(draft.query ?? (draft.repos?.length ? '' : '~/code/'));
    this.step.set(draft.step || 'repos');
    if (this.autoFocus()) this.focusStep();
  }
  protected state(step: NewProjectStep): 'active' | 'done' | 'todo' {
    return this.step() === step ? 'active' : this.order.indexOf(this.step()) > this.order.indexOf(step) ? 'done' : 'todo';
  }
  protected go(step: NewProjectStep): void { if (this.active() && !this.blocked()) { this.step.set(step); this.focusStep(); } }
  protected next(): void {
    if (!this.active() || !this.canNext()) return;
    if (this.step() === 'repos') this.go('name');
    else if (this.step() === 'name') this.go('look');
    else this.submit();
  }
  protected add(entry: FolderEntry): void {
    if (!this.active() || this.blocked() || this.addedPaths().includes(entry.path)) return;
    const repo: NewProjectRepo = { id: entry.path, name: entry.name || folderName(entry.path), path: entry.path, branch: entry.branch || null, clone: entry.clone || null };
    if (!this.named && !this.repos().length) this.appearance.update(face => ({ ...face, name: repo.name }));
    this.repos.update(repos => [...repos, repo]);
    this.query.set('');
  }
  protected remove(id: string): void {
    if (!this.active() || this.blocked()) return;
    this.repos.update(repos => repos.filter(repo => repo.id !== id));
    if (!this.named) this.appearance.update(face => ({ ...face, name: this.repos()[0]?.name || '' }));
    if (!this.repos().length) this.query.set('~/code/');
    this.folders()?.focus();
  }
  protected setName(event: Event): void {
    if (!this.active() || this.blocked() || !(event.target instanceof HTMLInputElement)) return;
    this.named = true;
    this.appearance.update(face => ({ ...face, name: event.target instanceof HTMLInputElement ? event.target.value : face.name }));
  }
  protected setQuery(query: string): void { if (this.active() && !this.blocked()) this.query.set(query); }
  protected setAppearance(appearance: ProjectAppearance): void { if (this.active() && !this.blocked()) this.appearance.set(appearance); }
  protected keydown(event: KeyboardEvent): void {
    if (!this.active()) return;
    if (event.key === 'Escape' && this.cancelable()) { event.preventDefault(); event.stopPropagation(); this.cancelled.emit(); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (this.step() === 'look' && !event.altKey))) { event.preventDefault(); this.submit(); }
    else if (event.key === 'Tab' && event.shiftKey && (event.target === this.nameField()?.nativeElement || this.footer()?.nativeElement.contains(event.target instanceof Node ? event.target : null))) {
      const index = this.order.indexOf(this.step());
      const previous = this.order[index - 1];
      if (previous) { event.preventDefault(); this.go(previous); }
    }
  }
  protected nameKey(event: KeyboardEvent): void {
    if (!this.active()) return;
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); event.stopPropagation(); this.next(); }
  }
  private submit(): void {
    if (!this.active() || !this.canCreate()) return;
    const face = this.appearance();
    this.create.emit({ project: { name: face.name.trim(), repos: this.repos(), look: face.look || 'letters', ...(face.look === 'emoji' ? { emoji: face.emoji } : face.look === 'icon' ? { icon: face.icon } : {}), hue: face.hue || projectHue(face.name) }, card: this.card().nativeElement });
  }
  private focusStep(): void {
    afterNextRender(() => {
      if (!this.active() || this.blocked()) return;
      if (this.step() === 'repos') this.folders()?.focus();
      else if (this.step() === 'name') { this.nameField()?.nativeElement.focus(); this.nameField()?.nativeElement.select(); }
      else this.footer()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
    }, { injector: this.injector });
  }
}
