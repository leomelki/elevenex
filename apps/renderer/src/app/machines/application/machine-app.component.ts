import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, linkedSignal, signal } from '@angular/core';
import type { RemoteChallenge } from '@elevenex/shared';
import { ButtonComponent, IconComponent, ModalLayerComponent, ToastComponent, ToastStackComponent } from '../../ui';
import { AddMachineComponent, GettingReadyComponent, IslandNameComponent, MachineHomeComponent, MachineLaunchComponent, MachinePanelComponent, TitleBarComponent, TitleIslandComponent, machineHomeStatus, EditMachineComponent, MachineMenuPopupComponent } from '../index';
import { MachineConnectionService } from './machine-connection.service';
import { MachineLauncherService } from './machine-launcher.service';
import { SshSetupService } from './ssh-setup.service';
import { engineSteps, remoteEngineSteps } from './machine-presentation';
import { RemoteChallengeDialogComponent } from './remote-challenge-dialog.component';
import { MachineActionsService } from './machine-actions.service';
import { MachineWorkspaceComponent } from './machine-workspace.component';
import { MachineErrorDialogComponent } from './machine-error-dialog.component';

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
  readonly challengeError = signal('');
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
  readonly update = computed(() => {
    if (!this.launcher.open()) return false;
    const state = this.connection.state();
    return this.launcher.currentId() === 'local'
      ? !!state && ['checking', 'downloading', 'extracting', 'starting'].includes(state.localBackend.phase)
      : state?.environment.connection?.phase === 'setting-up';
  });
  readonly steps = computed(() => {
    const state = this.connection.state();
    if (!state || !this.update()) return [];
    return this.launcher.currentId() === 'local' ? engineSteps(state.localBackend) : state.environment.connection ? remoteEngineSteps(state.environment.connection) : [];
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
    const notice = this.connectionNotice();
    if (notice) return { key: 'connection', text: notice.text, icon: 'server', tone: 'warn' as const, progress: undefined };
    if (!this.launcher.open()) return machineHomeStatus(this.launcher.machines(), this.launcher.pendingId());
    const machine = this.islandMachine();
    if (!machine?.busy) return null;
    return { key: `${machine.id}:${machine.busy.step}`, text: `${machine.name} · ${machine.busy.step.toLowerCase()}`, icon: machine.kind === 'local' ? 'download' : 'server', tone: 'info' as const, progress: machine.busy.progress };
  });

  constructor() {
    effect(onCleanup => {
      if (!this.launcher.open() || !this.connection.state()?.environment.connection?.retryAt) return;
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => { this.challenge(); this.challengeBusy.set(false); this.challengeError.set(''); });
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
    if (!event.defaultPrevented && !event.isComposing && !this.launcher.open() && !this.ssh.open() && !this.challenge() && !this.pairingOpen() && !this.actions.editOpen() && !this.actions.detailsOpen() && !this.actions.menu() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); this.find(); }
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
  async retry(): Promise<void> {
    try { await this.connection.retry(); }
    catch { if (!this.destroy.destroyed) this.launcher.error.set('The connection could not be retried. Try opening the machine again.'); }
  }
}
