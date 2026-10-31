import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterRenderEffect, computed, effect, inject, input, output, signal } from '@angular/core';
import { jumpHome, settleMark, type CreateProjectIntent } from '../../projects';
import { AppShellComponent } from '../../shell/app-shell.component';
import { ButtonComponent, IconComponent, SkeletonComponent } from '../../ui';
import { WorkspacePanelsComponent } from '../../workbench/workspace-panels.component';
import { WorkspaceDialogsComponent, WorkspaceNavigationComponent, WorkspaceOnboardingComponent, WorkspaceProjectRailComponent, WorkspaceStore, WorkspaceTaskSetupComponent, WorkspaceTaskHeaderComponent } from '../../workspace';
import type { Machine } from '../index';
import { SessionChatReviewComponent, type ChatReviewTarget } from '../../session-chat/session-chat-review.component';
import { SessionChatComponent } from '../../session-chat/session-chat.component';
import { SessionChatDrafts } from '../../session-chat/session-chat-drafts';
import { SessionChatClient } from '../../backend/session-chat-client.service';

/** Connected workspace lifetime. The machine owner retains chrome and transport recovery. */
@Component({
  selector: 'ex-machine-workspace',
  providers: [WorkspaceStore, SessionChatDrafts, SessionChatClient],
  imports: [SessionChatReviewComponent, SessionChatComponent, AppShellComponent, ButtonComponent, IconComponent, SkeletonComponent, WorkspacePanelsComponent, WorkspaceProjectRailComponent, WorkspaceNavigationComponent, WorkspaceTaskHeaderComponent, WorkspaceDialogsComponent, WorkspaceOnboardingComponent, WorkspaceTaskSetupComponent],
  templateUrl: './machine-workspace.component.html',
  styleUrl: './machine-workspace.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'shortcut($event)', '[attr.inert]': 'active() ? null : ""' },
})
export class MachineWorkspaceComponent {
  readonly machine = input.required<Machine>();
  readonly active = input(false);
  /** Prepare scoped reads behind inert Home while the selected machine gets ready. */
  readonly preparing = input(false);
  readonly generation = input(0);
  readonly prepared = output<{ readonly machineId: string; readonly generation: number }>();
  readonly changeRequested = output<void>();
  readonly store = inject(WorkspaceStore);
  readonly panelOpen = this.store.panelOpen;
  readonly panel = this.store.panel;
  readonly wideReview = this.store.wideReview;
  readonly reviewTarget = signal<ChatReviewTarget | null>(null);
  readonly selectedReview = computed(() => {
    const target = this.reviewTarget(), selected = this.store.selected();
    return target && selected && target.scopeId === selected.scopeId && target.taskId === selected.taskId && target.sessionId === selected.sessionId ? target : null;
  });
  review(target: ChatReviewTarget): void {
    this.reviewTarget.set(target); this.store.selectPanel('changes'); this.panelOpen.set(true);
  }
  readonly launch = signal<'idle' | 'creating' | 'flying'>('idle');
  private readonly setupStarted = signal(false);
  readonly onboarding = computed(() => this.launch() !== 'idle' || (!!this.store.scopeId() && !this.store.loading() && !this.store.projects().length && (!this.store.error() || this.setupStarted())));
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private source: CreateProjectIntent | null = null;
  private flights: Animation[] = [];
  private disposers: (() => void)[] = [];
  private launchRevision = 0;
  private readonly preparationMachineId = computed(() => this.machine().id);

  constructor() {
    effect(() => this.store.connect(this.machine(), this.active() || this.preparing()));
    afterRenderEffect(onCleanup => {
      const machineId = this.preparationMachineId(), generation = this.generation();
      // Let first-use templates/styles/layout paint before starting the launch.
      // Two frames cross a paint boundary; no backend response gates opening.
      let frame: number | undefined = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = undefined;
          this.prepared.emit({ machineId, generation });
        });
      });
      onCleanup(() => { if (frame !== undefined) cancelAnimationFrame(frame); });
    });
    effect(() => { if (!this.active()) this.stopLaunch(); });
    effect(() => { if (!this.store.scopeId()) this.stopLaunch(); });
    afterRenderEffect(() => {
      if (this.launch() !== 'creating' || this.store.busy()) return;
      if (this.store.projects().length) this.flyHome();
      else if (this.store.error()) { this.source = null; this.launch.set('idle'); }
    });
    afterRenderEffect(() => {
      const projectId = this.store.projectCreated();
      if (!projectId || this.onboarding() || this.store.dialogOpen() || this.store.loading() || this.store.activeProject() !== String(projectId)) return;
      const action = this.root.querySelector<HTMLButtonElement>('[data-new-task]');
      if (!action || action.disabled) return;
      action.focus({ preventScroll: true });
      this.store.projectCreated.set(null);
    });
    inject(DestroyRef).onDestroy(() => this.stopLaunch());
  }

  projectSubmitted(intent: CreateProjectIntent): void { this.setupStarted.set(true); this.source = intent; this.launch.set('creating'); }

  private flyHome(): void {
    const intent = this.source;
    this.launch.set('flying');
    const revision = ++this.launchRevision;
    const from = intent?.card.querySelector<HTMLElement>('[data-np="face"] ex-project-mark');
    const to = this.root.querySelector<HTMLElement>('[data-project-id] ex-project-mark');
    const finish = () => { if (revision === this.launchRevision) { this.launch.set('idle'); this.source = null; this.setupStarted.set(false); } };
    if (!intent || !from || !to) { finish(); return; }
    // Keep flight copies outside the modal's receding/blurred background. This
    // owner still cancels every copy when its workspace or scope goes away.
    const flightRoot = this.root.ownerDocument.body;
    const flight = jumpHome(flightRoot, from, to, { landed: element => {
      if (revision === this.launchRevision) this.disposers.push(settleMark(flightRoot, element, intent.project.hue));
    } });
    const name = intent.card.querySelector<HTMLElement>('[data-np="name"]');
    const heading = this.root.querySelector<HTMLElement>('ex-workspace-navigation h1');
    if (name && heading) {
      const nameFlight = jumpHome(flightRoot, name, heading, { text: intent.project.name, grow: .06, shadow: false, dur: 940, delay: 50, peak: 62, scale: heading.offsetHeight / Math.max(1, name.offsetHeight) });
      if (nameFlight) this.flights.push(nameFlight);
    }
    if (flight) { this.flights.push(flight); void flight.finished.then(finish, finish); }
    else finish();
  }

  private stopLaunch(): void {
    this.launchRevision++;
    for (const flight of this.flights) flight.cancel();
    for (const dispose of this.disposers) dispose();
    this.flights = []; this.disposers = []; this.source = null; this.launch.set('idle'); this.setupStarted.set(false);
  }

  closePanel(): void { this.panelOpen.set(false); this.wideReview.set(false); }
  togglePanel(): void { if (this.panelOpen()) this.closePanel(); else this.panelOpen.set(true); }

  shortcut(event: KeyboardEvent): void {
    if (!this.active() || event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey) || this.store.dialogOpen() || document.querySelector('.cdk-overlay-container [role="dialog"], ex-commit-panel [role="dialog"]')) return;
    const key = event.key.toLowerCase();
    if ((key === 'n' || event.code === 'KeyN') && event.altKey && !event.shiftKey && this.store.selected() && !this.store.busy() && this.store.selectedTask()?.state === 'ready') {
      event.preventDefault(); void this.store.createSession(String(this.store.selected()!.taskId));
    } else if (key === 'n' && !event.shiftKey && !event.altKey && this.store.projects().length) {
      event.preventDefault(); void this.store.openNewTask();
    } else if (event.shiftKey && key === 'r' && this.store.selected()) {
      event.preventDefault(); this.panel.set('changes');
      const wide = !this.wideReview(); this.panelOpen.set(true); this.wideReview.set(wide);
    } else if (/^[0-9]$/.test(key) && !event.shiftKey && !event.altKey && !this.store.busy()) {
      const projectId = key === '0' ? 'all' : this.store.projects()[Number(key) - 1]?.id;
      if (projectId) { event.preventDefault(); void this.store.selectProject(projectId); }
    }
  }
}
