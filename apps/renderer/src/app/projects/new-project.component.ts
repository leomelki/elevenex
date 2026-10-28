import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, OnInit, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { AutoHeightDirective, ButtonComponent, EaseSwapComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, StatusGlyphComponent } from '../ui';
import { ListPresence } from '../ui/motion/list-presence';
import { ProjectMarkComponent } from '../tasks/projects/project-mark.component';
import { FolderSuggestionsComponent } from './folder-suggestions.component';
import { ProjectAppearanceComponent } from './project-appearance.component';
import { folderName, projectFace, projectHue, projectInitials } from './project-face';
import type { CreateProjectIntent, FolderEntry, FolderProvider, NewProjectDraft, NewProjectRepo, NewProjectStep, ProjectAppearance, ProjectNameProvider } from './project.models';

@Component({
  selector: 'ex-new-project',
  imports: [AutoHeightDirective, ButtonComponent, EaseSwapComponent, FoldComponent, IconButtonComponent, IconComponent, KbdComponent, StatusGlyphComponent, ProjectMarkComponent, FolderSuggestionsComponent, ProjectAppearanceComponent],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.launching]': 'launching()', '[attr.inert]': 'active() ? null : ""' },
})
export class NewProjectComponent implements OnInit {
  readonly machine = input('this machine');
  readonly machineIcon = input('server');
  readonly listFolders = input<FolderProvider>();
  readonly checkName = input<ProjectNameProvider>();
  /** Initial unfinished interaction state; remount to begin a different draft. */
  readonly draft = input<NewProjectDraft>({ name: '' });
  readonly autoFocus = input(true);
  /** Retain the rendered draft during exit while stopping interaction and folder work. */
  readonly active = input(true);
  readonly cancelable = input(false);
  readonly busy = input(false);
  /** Unavailable integrations can disable a draft without claiming work is in progress. */
  readonly disabled = input(false);
  readonly error = input<string | null>(null);
  readonly recoveryRequired = input(false);
  readonly recovering = input(false);
  readonly recoveryRequested = output<void>();
  protected readonly blocked = computed(() => this.busy() || this.disabled() || this.recoveryRequired() || this.recovering());
  /** Conceals only the source face/name while their owner animates copies. */
  readonly launching = input(false);
  readonly create = output<CreateProjectIntent>();
  readonly cancelled = output<void>();
  protected readonly step = signal<NewProjectStep>('repos');
  protected readonly repos = signal<readonly NewProjectRepo[]>([]);
  protected readonly query = signal('~/');
  protected readonly appearance = signal<ProjectAppearance>({ name: '', look: 'letters', emoji: '🛒', icon: 'repo' });
  protected readonly face = computed(() => projectFace(this.appearance()));
  protected readonly blankFace = computed(() => (this.appearance().look || 'letters') === 'letters' && !projectInitials(this.appearance().name));
  protected readonly addedPaths = computed(() => this.repos().map(repo => repo.path));
  protected readonly repoSummary = computed(() => this.repos().map(repo => repo.name).join(', '));
  private readonly name = computed(() => this.appearance().name.trim());
  private readonly validNameSyntax = computed(() => !!this.name() && this.appearance().name.length <= 100);
  private readonly nameReply = signal<{ readonly name: string; readonly provider: ProjectNameProvider; readonly available: boolean; readonly failed: boolean } | null>(null);
  protected readonly nameStatusId = `project-name-${crypto.randomUUID()}`;
  private readonly currentNameReply = computed(() => {
    const reply = this.nameReply();
    return reply?.name === this.name() && reply.provider === this.checkName() ? reply : null;
  });
  protected readonly namePending = computed(() => !!this.checkName() && this.validNameSyntax() && !this.currentNameReply());
  protected readonly nameFailed = computed(() => this.currentNameReply()?.failed === true);
  protected readonly nameTaken = computed(() => this.currentNameReply()?.available === false && !this.nameFailed());
  protected readonly validName = computed(() => this.validNameSyntax() && (!this.checkName() || this.currentNameReply()?.available === true));
  protected readonly canCreate = computed(() => this.repos().length > 0 && this.repos().length <= 20 && this.validName() && !this.blocked());
  protected readonly canNext = computed(() => !this.blocked() && (this.step() === 'repos' ? this.repos().length > 0 && this.repos().length <= 20 : this.step() === 'name' ? this.validName() : this.canCreate()));
  protected readonly order: readonly NewProjectStep[] = ['repos', 'name', 'look'];
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');
  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');
  private readonly folders = viewChild(FolderSuggestionsComponent);
  private readonly footer = viewChild<ElementRef<HTMLElement>>('footer');
  private named = false;
  protected readonly presence = new ListPresence(this.repos, repo => repo.id, this.root, inject(DestroyRef));

  constructor() {
    effect(onCleanup => {
      const provider = this.checkName(), name = this.name(), active = this.active() && !this.disabled(), valid = this.validNameSyntax();
      this.nameReply.set(null);
      if (!provider || !active || !valid) return;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        Promise.resolve().then(() => provider(name, controller.signal)).then(available => {
          if (!controller.signal.aborted) this.nameReply.set({ name, provider, available, failed: false });
        }, () => {
          if (!controller.signal.aborted) this.nameReply.set({ name, provider, available: false, failed: true });
        });
      }, 140);
      onCleanup(() => { clearTimeout(timer); controller.abort(); });
    });
  }

  ngOnInit(): void {
    const draft = this.draft();
    this.repos.set(draft.repos ?? []);
    this.appearance.set({ name: draft.name || draft.repos?.[0]?.name || '', look: draft.look || 'letters', emoji: draft.emoji || '🛒', icon: draft.icon || 'repo', hue: draft.hue });
    this.named = !!draft.name;
    this.query.set(draft.query ?? (draft.repos?.length ? '' : '~/'));
    this.step.set(draft.step || 'repos');
    if (this.autoFocus()) this.focusStep();
  }
  protected state(step: NewProjectStep): 'active' | 'done' | 'todo' {
    return this.step() === step ? 'active' : this.order.indexOf(this.step()) > this.order.indexOf(step) ? 'done' : 'todo';
  }
  protected canVisit(step: NewProjectStep): boolean { return step !== 'look' || (this.repos().length > 0 && this.validName()); }
  protected go(step: NewProjectStep): void { if (this.active() && !this.blocked() && this.canVisit(step)) { this.step.set(step); this.focusStep(); } }
  protected next(): void {
    if (!this.active() || !this.canNext()) return;
    if (this.step() === 'repos') this.go('name');
    else if (this.step() === 'name') this.go('look');
    else this.submit();
  }
  protected add(entry: FolderEntry): void {
    if (!this.active() || this.blocked() || this.repos().length >= 20 || this.addedPaths().includes(entry.path)) return;
    const repo: NewProjectRepo = {
      id: entry.path,
      name: entry.name || folderName(entry.path),
      path: entry.path,
      branch: entry.branch || (entry.git && !['git', 'Git repository'].includes(entry.git) ? entry.git : null),
      clone: entry.clone || null,
      initialize: !entry.git && !entry.clone,
    };
    if (!this.named && !this.repos().length) this.appearance.update(face => ({ ...face, name: repo.name }));
    this.repos.update(repos => [...repos, repo]);
    this.query.set('');
    if (this.repos().length === 20) this.focusStep();
  }
  protected remove(id: string): void {
    if (!this.active() || this.blocked()) return;
    this.repos.update(repos => repos.filter(repo => repo.id !== id));
    if (!this.named) this.appearance.update(face => ({ ...face, name: this.repos()[0]?.name || '' }));
    if (!this.repos().length) this.query.set('~/');
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
    if (!this.active() || event.isComposing) return;
    if (event.key === 'Escape' && this.cancelable() && !this.busy()) { event.preventDefault(); event.stopPropagation(); this.cancelled.emit(); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (this.step() === 'look' && event.target === this.card().nativeElement && !event.altKey))) { event.preventDefault(); this.submit(); }
    else if (event.key === 'Tab' && event.shiftKey && (event.target === this.nameField()?.nativeElement || event.target === this.footer()?.nativeElement.querySelector('button'))) {
      const index = this.order.indexOf(this.step());
      const previous = this.order[index - 1];
      if (previous) { event.preventDefault(); this.go(previous); }
    }
  }
  protected nameKey(event: KeyboardEvent): void {
    if (!this.active() || event.isComposing) return;
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
      if (this.step() === 'repos' && this.repos().length < 20) this.folders()?.focus();
      else if (this.step() === 'name') { this.nameField()?.nativeElement.focus(); this.nameField()?.nativeElement.select(); }
      else this.footer()?.nativeElement.querySelector<HTMLButtonElement>('button')?.focus();
    }, { injector: this.injector });
  }
}
