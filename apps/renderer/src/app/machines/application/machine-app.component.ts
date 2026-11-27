import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import type { RemoteChallenge, RemoteConnectionStatus } from '@elevenex/shared';
import { ButtonComponent, IconComponent, ModalLayerComponent, ToastComponent, ToastStackComponent } from '../../ui';
import { AddMachineComponent, GettingReadyComponent, IslandNameComponent, MachineHomeComponent, MachineLaunchComponent, MachinePanelComponent, TitleBarComponent, TitleIslandComponent, machineHomeStatus, EditMachineComponent, MachineMenuPopupComponent } from '../index';
import { MachineConnectionService } from './machine-connection.service';
import { MachineLauncherService } from './machine-launcher.service';
import { SshSetupService } from './ssh-setup.service';
import { engineSteps, remoteEngineSteps } from './machine-presentation';
import { RemoteChallengeDialogComponent } from './remote-challenge-dialog.component';
import { MachineActionsService } from './machine-actions.service';
import { MachineWorkspaceComponent } from './machine-workspace.component';
import { machineReach } from './machine-reach';
import { MachineErrorDialogComponent } from './machine-error-dialog.component';

type WaitingUpdate = NonNullable<RemoteConnectionStatus['updateWaiting']> & { readonly hostId: string; readonly name: string };
interface ServerChoice { readonly hostId: string; readonly name: string }
const signInHint = 'Sign in on that PC in person or with Remote Desktop.';

/** Production composition. Presentational families remain supplied-data APIs. */
@Component({
  selector: 'ex-machine-app',
  providers: [MachineConnectionService, MachineLauncherService, SshSetupService, MachineActionsService],
  imports: [ButtonComponent, IconComponent, ModalLayerComponent, ToastComponent, ToastStackComponent, EditMachineComponent, MachineMenuPopupComponent, AddMachineComponent, GettingReadyComponent, IslandNameComponent, MachineHomeComponent, MachineLaunchComponent, MachinePanelComponent, TitleBarComponent, TitleIslandComponent, RemoteChallengeDialogComponent, MachineWorkspaceComponent, MachineErrorDialogComponent],
  templateUrl: './machine-app.component.html',
  styleUrl: './machine-app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'shortcut($event)' },
})
export class MachineAppComponent {
  readonly launcher = inject(MachineLauncherService);
  readonly connection = inject(MachineConnectionService);
  readonly ssh = inject(SshSetupService);
  readonly actions = inject(MachineActionsService);
  private readonly destroy = inject(DestroyRef);
  readonly ping = signal<{ readonly id: string; readonly at: number } | null>(null);
  readonly findOpen = signal(false);
  readonly backMachine = computed(() => !this.launcher.open() && this.launcher.current()?.conn === 'live' && this.launcher.selectedId() === this.launcher.currentId() ? this.launcher.current() : null);
  readonly panelOpen = signal(false);
  readonly pairingOpen = signal(false);
  readonly pairingFrom = signal<HTMLElement | null>(null);
  readonly challengeBusy = signal(false);
  readonly reviewTrust = signal(false);
  readonly backOnline = signal(false);
  readonly challengeError = signal('');
  readonly updateActionBusy = signal(false);
  readonly updateActionError = signal('');
  readonly waitingUpdate = computed<WaitingUpdate | null>(() => {
    const environment = this.connection.state()?.environment;
    if (!environment || environment.selection.kind !== 'remote') return null;
    const update = environment.connection?.updateWaiting;
    if (!update) return null;
    const hostId = environment.selection.hostId;
    return { ...update, hostId, name: this.launcher.machines().find(machine => machine.id === hostId)?.name ?? 'this server' };
  });
  readonly retainedUpdate = linkedSignal<WaitingUpdate | null, WaitingUpdate | null>({
    source: this.waitingUpdate, computation: (update, previous) => update ?? previous?.value ?? null,
  });
  /** A Windows connect paused because nobody is signed in to the desktop. */
  readonly sessionChoice = computed<ServerChoice | null>(() => {
    const environment = this.connection.state()?.environment;
    if (!environment || environment.selection.kind !== 'remote') return null;
    const connection = environment.connection;
    return connection?.phase === 'paused' && connection.failure?.action === 'choose-session' ? this.serverChoice(environment.selection.hostId) : null;
  });
  readonly retainedSessionChoice = linkedSignal<ServerChoice | null, ServerChoice | null>({
    source: this.sessionChoice, computation: (choice, previous) => choice ?? previous?.value ?? null,
  });
  readonly sessionChoiceBusy = signal(false);
  readonly sessionChoiceError = signal('');
  readonly signInHint = signInHint;
  /** Confirmation for moving a background Windows engine to the desktop session. */
  readonly desktopSwitch = signal<ServerChoice | null>(null);
  readonly retainedDesktopSwitch = linkedSignal<ServerChoice | null, ServerChoice | null>({
    source: this.desktopSwitch, computation: (choice, previous) => choice ?? previous?.value ?? null,
  });
  readonly desktopSwitchBusy = signal(false);
  readonly desktopSwitchError = signal('');
  readonly challenge = computed(() => this.connection.state()?.environment.challenge ?? null);
  // Keep the last dialog and its data mounted throughout ModalLayer's exit.
  readonly retainedChallenge = linkedSignal<RemoteChallenge | null, RemoteChallenge | null>({
    source: this.challenge,
    computation: (challenge, previous) => challenge ?? previous?.value ?? null,
  });
  private readonly now = signal(Date.now());
  readonly islandMachine = computed(() => {
    const id = this.launcher.open() ? this.launcher.currentId() : this.launcher.pendingId() ?? this.launcher.selectedId();
    return this.launcher.machines().find(machine => machine.id === id) ?? this.launcher.machines()[0] ?? null;
  });
  readonly update = linkedSignal({
    source: () => {
      const state = this.connection.state(), machineId = this.launcher.currentId();
      const local = state?.localBackend.phase, remote = state?.environment.connection;
      return { machineId, open: this.launcher.open(),
        installing: machineId === 'local' ? !!local && ['checking', 'downloading', 'extracting'].includes(local)
          : remote?.phase === 'setting-up' && ['download', 'installation'].includes(remote.stage),
        starting: machineId === 'local' ? local === 'starting' : remote?.phase === 'setting-up' };
    },
    // Retain a real engine update through startup, while an ordinary crash or
    // warm SSH reconnect keeps the already loaded workspace on screen.
    computation: (state, previous): boolean => state.open && (state.installing || state.starting && !!previous && previous.source.machineId === state.machineId && previous.value),
  });
  readonly steps = computed(() => {
    const state = this.connection.state();
    if (!state || !this.update()) return [];
    return this.launcher.currentId() === 'local' ? engineSteps(state.localBackend) : state.environment.connection ? remoteEngineSteps(state.environment.connection) : [];
  });
  readonly unreachable = computed(() => this.launcher.open() && !!this.launcher.current() && this.launcher.current()?.conn !== 'live' && !this.update());
  readonly outageSince = linkedSignal<{ readonly id: string | null; readonly offline: boolean }, number | null>({
    source: () => ({ id: this.launcher.currentId(), offline: this.unreachable() }),
    computation: (value, previous) => value.offline ? previous?.source.id === value.id && previous.source.offline ? previous.value : Date.now() : null,
  });
  readonly askSince = linkedSignal({
    source: () => this.challenge()?.id ?? (this.connection.state()?.environment.connection?.phase === 'paused' ? this.connection.state()?.environment.connection?.failure?.code : null),
    computation: identity => identity ? Date.now() : null,
  });
  readonly recoveryAction = computed(() => {
    const challenge = this.challenge();
    if (this.connection.state()?.environment.connection?.failure?.code === 'host-trust' || challenge?.kind === 'trust') return 'Check';
    if (!challenge) return 'Try now';
    if (challenge.kind !== 'credential') return 'Show';
    return /passphrase/i.test(challenge.prompt) ? 'Unlock' : /password/i.test(challenge.prompt) ? 'Sign in' : 'Continue';
  });
  readonly reach = computed(() => {
    const since = this.outageSince();
    return since === null ? null : machineReach(this.launcher.current()?.name ?? 'The machine', since, this.now(), this.connection.state()?.environment.connection ?? null, this.challenge(), this.askSince() ?? since);
  });
  readonly connectionNotice = computed(() => {
    if (!this.launcher.open() || this.update()) return null;
    const machine = this.launcher.current();
    if (!machine || machine.conn === 'live') return null;
    const remote = this.connection.state()?.environment.connection;
    const retryAt = remote?.retryAt;
    return { text: retryAt ? `Connection lost · reconnecting in ${Math.max(0, Math.ceil((retryAt - this.now()) / 1000))} s` : machine.busy?.step ?? machine.last ?? 'Connection unavailable',
      retry: !machine.busy || remote?.phase === 'paused' };
  });
  readonly island = computed(() => {
    const reach = this.reach();
    if (reach) return { key: reach.key, text: reach.text, icon: 'server', tone: reach.tone, progress: undefined };
    if (this.unreachable()) return null;
    if (this.backOnline()) return { key: 'back', text: 'Back online · checking your work', icon: 'check', tone: 'ok' as const, progress: undefined };
    if (!this.launcher.open()) return machineHomeStatus(this.launcher.machines(), this.launcher.pendingId());
    const machine = this.islandMachine();
    if (!machine?.busy) return null;
    return { key: `${machine.id}:${machine.busy.step}`, text: `${machine.name} · ${machine.busy.step.toLowerCase()}`, icon: machine.kind === 'local' ? 'download' : 'server', tone: 'info' as const, progress: machine.busy.progress };
  });

  constructor() {
    effect(onCleanup => {
      if (!this.unreachable()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => { this.challenge(); this.challengeBusy.set(false); this.challengeError.set(''); this.reviewTrust.set(false); });
    let wasOffline = false;
    effect(onCleanup => {
      const offline = this.unreachable();
      if (wasOffline && !offline && this.launcher.open()) {
        untracked(() => this.backOnline.set(true));
        const timer = setTimeout(() => this.backOnline.set(false), 4000);
        onCleanup(() => clearTimeout(timer));
      } else if (offline) untracked(() => this.backOnline.set(false));
      wasOffline = offline;
    });
  }
  pressIsland(): void {
    if (this.launcher.open()) { this.panelOpen.set(!this.panelOpen()); return; }
    const status = machineHomeStatus(this.launcher.machines(), this.launcher.pendingId());
    if (status) this.pointAt(status.machineId);
    else if (this.backMachine()) void this.launcher.choose(this.backMachine()!.id);
    else this.find();
  }
  find(): void {
    if (this.launcher.firstRun()) { const local = this.launcher.machines().find(machine => machine.kind === 'local'); if (local) this.pointAt(local.id); }
    else this.findOpen.set(true);
  }
  private pointAt(id: string): void { this.ping.update(previous => ({ id, at: (previous?.at ?? 0) + 1 })); }
  shortcut(event: KeyboardEvent): void {
    if (!event.defaultPrevented && !event.isComposing && !this.launcher.open() && !this.ssh.open() && !this.challenge() && !this.waitingUpdate() && !this.pairingOpen() && !this.actions.editOpen() && !this.actions.detailsOpen() && !this.actions.menu() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); this.find(); }
  }
  home(): void { this.panelOpen.set(false); this.launcher.home(); }
  pair(from: HTMLElement): void { this.pairingFrom.set(from); this.pairingOpen.set(true); }
  cancelChallenge(): void { const challenge = this.challenge(); if (challenge) void this.answer({ id: challenge.id, answer: null }); }
  async answer(event: { readonly id: string; readonly answer: string | null }): Promise<void> {
    if (this.challengeBusy() || this.challenge()?.id !== event.id) return;
    this.challengeBusy.set(true); this.challengeError.set('');
    try {
      if (event.answer === null) {
        this.launcher.pendingId.set(null);
        await this.connection.disconnect();
      } else await this.connection.answer(event.id, event.answer);
    } catch {
      if (!this.destroy.destroyed && this.challenge()?.id === event.id) this.challengeError.set('The sign-in response could not be sent. Cancel and try again.');
    } finally { if (!this.destroy.destroyed && this.challenge()?.id === event.id) this.challengeBusy.set(false); }
  }
  reconnect(): void { this.panelOpen.set(true); if (!this.challenge()) void this.retry(); }
  async retry(): Promise<void> {
    try { await this.connection.retry(); }
    catch { if (!this.destroy.destroyed) this.launcher.error.set('The connection could not be retried. Try opening the machine again.'); }
  }
  async chooseSession(choice: 'without-apps' | 'retry' | 'cancel'): Promise<void> {
    const pending = this.sessionChoice();
    if (!pending || this.sessionChoiceBusy()) return;
    this.sessionChoiceBusy.set(true); this.sessionChoiceError.set('');
    try {
      if (choice === 'without-apps') await this.connection.startWithoutApps(pending.hostId);
      else if (choice === 'retry') await this.connection.retry();
      else { this.launcher.pendingId.set(null); await this.connection.disconnect(); }
    } catch {
      if (!this.destroy.destroyed && this.sessionChoice()?.hostId === pending.hostId) this.sessionChoiceError.set('The request could not be sent. Try again.');
    } finally { if (!this.destroy.destroyed) this.sessionChoiceBusy.set(false); }
  }
  requestDesktopSession(): void {
    const selection = this.connection.state()?.environment.selection;
    if (selection?.kind !== 'remote' || this.desktopSwitch()) return;
    this.desktopSwitchError.set('');
    this.desktopSwitch.set(this.serverChoice(selection.hostId));
  }
  closeDesktopSwitch(): void { if (!this.desktopSwitchBusy()) this.desktopSwitch.set(null); }
  async confirmDesktopSession(): Promise<void> {
    const pending = this.desktopSwitch();
    if (!pending || this.desktopSwitchBusy()) return;
    this.desktopSwitchBusy.set(true); this.desktopSwitchError.set('');
    try {
      const outcome = await this.connection.useDesktopSession(pending.hostId);
      if (this.destroy.destroyed) return;
      if (outcome === 'switching') this.desktopSwitch.set(null);
      else this.desktopSwitchError.set(`Nobody is signed in to Windows on ${pending.name} yet. ${signInHint} Then switch again.`);
    } catch {
      if (!this.destroy.destroyed) this.desktopSwitchError.set('The engine could not be switched. Check the connection, then try again.');
    } finally { if (!this.destroy.destroyed) this.desktopSwitchBusy.set(false); }
  }
  private serverChoice(hostId: string): ServerChoice {
    return { hostId, name: this.launcher.machines().find(machine => machine.id === hostId)?.name ?? 'this server' };
  }
  async respondToUpdate(force: boolean): Promise<void> {
    const update = this.waitingUpdate();
    if (!update || this.updateActionBusy()) return;
    this.updateActionBusy.set(true);
    this.updateActionError.set('');
    try {
      if (force) await this.connection.forceUpdate(update.hostId, update.instance);
      else await this.connection.disconnect();
    } catch {
      if (!this.destroy.destroyed && this.waitingUpdate()?.instance === update.instance) this.updateActionError.set('The request could not be sent. Try again.');
    } finally {
      if (!this.destroy.destroyed) this.updateActionBusy.set(false);
    }
  }
}
