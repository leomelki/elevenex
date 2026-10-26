import { DestroyRef, Injectable, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { BackendClientService } from '../../backend/backend-client.service';
import type { Machine, MachineOpenEvent } from '../index';
import { MachineConnectionService } from './machine-connection.service';
import { machineId, machineSelection, presentMachines } from './machine-presentation';

/** Owns this window's launch intent. Home never connects unselected servers. */
@Injectable()
export class MachineLauncherService {
  readonly connection = inject(MachineConnectionService);
  private readonly client = inject(BackendClientService);
  private readonly destroy = inject(DestroyRef);
  readonly open = signal(false);
  readonly currentId = signal<string | null>(null);
  readonly pendingId = signal<string | null>(null);
  readonly error = signal('');
  private readonly openedHere = signal(false);
  private readonly selecting = signal(false);
  private readonly request = signal(0);
  private settle = false;
  private initialRequestConsumed = false;
  readonly firstRun = computed(() => !this.openedHere() && !this.connection.state()?.hasOpenedMachine);
  readonly machines = linkedSignal<readonly Machine[], readonly Machine[]>({
    source: () => {
      const state = this.connection.state();
      return state ? presentMachines(state, this.connection.platform === 'darwin' ? 'This Mac' : this.connection.platform === 'win32' ? 'This PC' : 'This computer') : [];
    },
    computation: (machines, previous) => {
      const beforeById = new Map(previous?.value.map(machine => [machine.id, machine]));
      return machines.map(machine => {
        const before = beforeById.get(machine.id);
        if (machine.error) return { ...machine, error: { ...machine.error, progress: machine.error.progress ?? before?.busy?.progress ?? before?.error?.progress } };
        // Releasing a failed server's connection must not erase its actionable card.
        // A fresh busy/ready snapshot or a changed destination clears this memory.
        if (machine.kind !== 'local' && machine.conn === 'idle' && !machine.busy && before?.error && before.address === machine.address) {
          return { ...machine, conn: 'fail', last: before.last, error: before.error };
        }
        return machine;
      });
    },
  });
  readonly current = computed(() => this.machines().find(machine => machine.id === this.currentId()) ?? null);
  readonly selectedId = computed(() => {
    const selection = this.connection.state()?.environment.selection;
    return selection ? machineId(selection) : null;
  });
  private readonly readyId = computed(() => {
    const pending = this.pendingId();
    const machine = this.machines().find(machine => machine.id === pending);
    const scope = this.client.state().scope;
    return !this.selecting() && machine?.conn === 'live' && !machine.busy && scope && machineId(scope.environment) === pending && this.selectedId() === pending ? pending : null;
  });

  constructor() {
    effect(() => {
      const id = this.currentId();
      if (!id || id === 'local') return;
      const machine = this.machines().find(machine => machine.id === id);
      const environment = this.connection.state()?.environment;
      if (!machine || this.open() && !this.pendingId() && environment?.selection.kind === 'remote' && environment.selection.hostId === id && environment.connection?.phase === 'disconnected') {
        untracked(() => { this.home(); if (!machine) this.currentId.set(null); });
      }
    });
    effect(onCleanup => {
      const id = this.readyId();
      if (!id) return;
      const request = this.request();
      const timer = setTimeout(() => {
        if (this.destroy.destroyed || this.request() !== request || this.readyId() !== id) return;
        this.pendingId.set(null); this.currentId.set(id); this.open.set(true); this.openedHere.set(true);
        void this.connection.opened(machineSelection(id)).catch(() => {
          if (!this.destroy.destroyed) this.error.set('The machine opened, but first-run preferences could not be saved.');
        });
      }, this.settle ? 450 : 0);
      onCleanup(() => clearTimeout(timer));
    });
    effect(() => {
      const state = this.connection.state();
      if (!state || this.initialRequestConsumed) return;
      this.initialRequestConsumed = true;
      const selection = state.launchSelection;
      if (selection) untracked(() => { void this.choose(machineId(selection)); });
    });
    effect(() => {
      const id = this.pendingId();
      if (!id || this.selecting() || this.selectedId() !== id) return;
      const machine = this.machines().find(machine => machine.id === id);
      if (id !== 'local' && this.connection.state()?.environment.connection?.phase === 'disconnected') {
        untracked(() => this.pendingId.set(null)); return;
      }
      if (machine?.conn === 'fail' || (id !== 'local' && this.connection.state()?.environment.connection?.phase === 'paused')) {
        untracked(() => { this.pendingId.set(null); if (!machine?.error) this.error.set(machine?.last ?? 'The connection paused. Open the machine to try again.'); });
      }
    });
    this.destroy.onDestroy(() => this.request.update(value => value + 1));
  }

  async openMachine(event: MachineOpenEvent): Promise<void> {
    if (event.newWindow) {
      try { await this.connection.newWindow(machineSelection(event.machine.id)); }
      catch { if (!this.destroy.destroyed) this.error.set('A new window could not be opened. Try again.'); }
    } else await this.choose(event.machine.id);
  }

  async choose(id: string): Promise<void> {
    if (this.destroy.destroyed || this.pendingId() === id || !this.machines().some(machine => machine.id === id)) return;
    this.request.update(value => value + 1);
    const request = this.request();
    this.error.set(''); this.pendingId.set(id); this.selecting.set(true);
    this.settle = this.machines().find(machine => machine.id === id)?.conn !== 'live';
    try {
      const current = this.connection.state();
      if (this.selectedId() !== id) await this.connection.select(machineSelection(id));
      else if (id === 'local' ? ['failed', 'stopped'].includes(current?.localBackend.phase ?? '') : ['paused', 'disconnected'].includes(current?.environment.connection?.phase ?? 'disconnected')) await this.connection.retry();
    } catch {
      if (!this.destroy.destroyed && request === this.request()) { this.pendingId.set(null); this.error.set('This machine could not be opened. Check its connection and try again.'); }
    } finally { if (!this.destroy.destroyed && request === this.request()) this.selecting.set(false); }
  }

  home(): void { this.request.update(value => value + 1); this.pendingId.set(null); this.selecting.set(false); this.open.set(false); }
  async newWindow(): Promise<void> {
    try { await this.connection.newWindow(null); }
    catch { if (!this.destroy.destroyed) this.error.set('A new window could not be opened. Try again.'); }
  }
  async disconnect(): Promise<void> {
    this.home();
    try { await this.connection.disconnect(); }
    catch { if (!this.destroy.destroyed) this.error.set('The connection could not be closed. Try again.'); }
  }
}
