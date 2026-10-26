import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { ButtonComponent, IconComponent, ModalLayerComponent } from '../src/app/ui';
import { AddMachineComponent, AddMachineIntent, AddMachineKind, GettingReadyComponent, IslandNameComponent, Machine, MachineHomeComponent, MachineLaunchComponent, MachineOpenEvent, PairedComputer, PickedHost, SshHost, TitleBarComponent, TitleIslandComponent, machineHomeStatus, machineConnected } from '../src/app/machines';
import { NewProjectComponent, FolderProvider } from '../src/app/projects';
import { ProjectRailComponent } from '../src/app/tasks/projects/project-rail.component';

const LOCAL: Machine = { id: 'local', name: 'This Mac', kind: 'local', conn: 'idle', color: 'pine', busy: { step: 'Downloading the engine', progress: .42, meta: '42%' } };
const SAVED: readonly Machine[] = [
  { ...LOCAL, conn: 'live', busy: undefined, status: 'Idle' },
  { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'live', color: 'ocean', status: '3 running · 1 needs you', windows: 1 },
  { id: 'mini', name: 'Studio Mac', kind: 'peer', conn: 'idle', color: 'plum', last: 'Paired · opened yesterday' },
  { id: 'build', name: 'build-arm64', kind: 'ssh', conn: 'idle', color: 'rust', last: 'Opened 3 days ago', update: '1.5.2' },
];

/** Preview-only application owner: no real SSH, filesystem, engines or pairing. */
@Component({
  selector: 'ex-machine-flow-demo',
  imports: [ButtonComponent, IconComponent, ModalLayerComponent, AddMachineComponent, MachineHomeComponent, MachineLaunchComponent, TitleBarComponent, TitleIslandComponent, IslandNameComponent, GettingReadyComponent, ProjectRailComponent, NewProjectComponent],
  templateUrl: './machine-flow-demo.component.html',
  styleUrl: './machine-flow-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineFlowDemoComponent {
  readonly machines = signal<readonly Machine[]>([LOCAL]);
  readonly firstRun = signal(true);
  readonly ping = signal<{ readonly id: string; readonly at: number } | null>(null);
  readonly findOpen = signal(false);
  readonly wasOpened = signal(false);
  readonly opened = signal(false);
  readonly current = signal<Machine>(LOCAL);
  readonly pending = signal<MachineOpenEvent | null>(null);
  readonly updating = signal(false);
  readonly dialogOpen = signal(false);
  readonly dialogKind = signal<AddMachineKind>('ssh');
  readonly dialogFrom = signal<HTMLElement | null>(null);
  readonly step = signal<'host' | 'key'>('host');
  readonly query = signal('');
  readonly picked = signal<PickedHost | null>(null);
  readonly fingerprint = signal('');
  readonly pairText = signal('');
  readonly found = signal<PairedComputer | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly event = signal('Preview data only. Select a machine; advance preparation with the controls.');
  readonly islandStatus = computed(() => {
    if (this.updating()) return { key: `update-${this.current().id}`, text: `Updating ${this.current().name} 56%`, icon: 'refresh', progress: .56, tone: 'info' as const };
    if (this.opened()) return null;
    return machineHomeStatus(this.machines(), this.pending()?.machine.id);
  });
  readonly hosts: readonly SshHost[] = [{ id: 'dev', name: 'dev-box', detail: 'leo@dev-box.internal' }, { id: 'gpu', name: 'gpu-runner', detail: 'ubuntu@10.0.4.12' }];
  readonly folders: FolderProvider = query => ['payments-api', 'storefront-web'].filter(name => name.startsWith(query.split('/').pop() ?? '')).map(name => ({ path: `~/code/${name}`, name, git: 'main · 214 commits', branch: 'main' }));
  readonly ready = computed(() => {
    const pending = this.pending();
    const machine = this.machines().find(machine => machine.id === pending?.machine.id);
    return pending && machine && !machine.busy && !machine.update && machineConnected(machine) ? { machine, newWindow: pending.newWindow } : null;
  });
  private request?: AbortController;
  private nextMachine = 0;

  constructor() {
    // The owning flow waits for the ready card to settle. A different selection,
    // failure, reset, navigation or destruction cancels the old launch.
    effect(onCleanup => {
      const ready = this.ready();
      if (!ready) return;
      const timer = setTimeout(() => { this.pending.set(null); this.launch(ready); }, 450);
      onCleanup(() => clearTimeout(timer));
    });
    inject(DestroyRef).onDestroy(() => this.request?.abort());
  }

  pressIsland(): void {
    if (this.opened()) { this.opened.set(false); this.updating.set(false); return; }
    const status = machineHomeStatus(this.machines(), this.pending()?.machine.id);
    if (status || this.firstRun()) this.ping.update(previous => ({ id: status?.machineId ?? 'local', at: (previous?.at ?? 0) + 1 }));
    else if (this.wasOpened()) this.openMachine({ machine: this.current(), newWindow: false });
    else this.findOpen.set(true);
  }

  reset(firstRun: boolean): void {
    this.request?.abort(); this.pending.set(null); this.opened.set(false); this.wasOpened.set(false); this.findOpen.set(false); this.ping.set(null); this.updating.set(false); this.dialogOpen.set(false);
    this.firstRun.set(firstRun); this.machines.set(firstRun ? [LOCAL] : SAVED); this.current.set(firstRun ? LOCAL : SAVED[0]!);
    this.event.set('Preview reset. No platform operations performed.');
  }

  openMachine(event: MachineOpenEvent): void {
    this.pending.set(null);
    const machine = this.machines().find(machine => machine.id === event.machine.id);
    if (!machine) return;
    if (machine.busy || machine.update || !machineConnected(machine)) {
      this.pending.set({ ...event, machine });
      if (!machine.busy) this.machines.update(machines => machines.map(item => item.id === machine.id ? { ...item, error: undefined, busy: { step: machine.update ? 'Updating the engine' : 'Connecting', progress: .15, meta: '15%' } } : item));
      this.event.set(`Preparing ${machine.name}. It will open once ready.`);
    } else this.launch({ ...event, machine });
  }

  advance(complete = false): void {
    this.machines.update(machines => machines.map(machine => machine.busy ? complete
      ? { ...machine, busy: undefined, update: undefined, conn: 'live', status: 'Ready to work' }
      : { ...machine, busy: { step: 'Starting Elevenex', progress: .78, meta: '78%' } } : machine));
  }

  fail(): void {
    this.machines.update(machines => machines.map(machine => machine.busy ? { ...machine, busy: undefined, conn: 'fail', last: 'Could not connect just now', error: { step: machine.kind === 'local' ? 'Download stopped · you’re offline' : 'Could not connect just now', progress: machine.busy.progress } } : machine));
    this.pending.set(null); this.event.set('Connection failed on the card. Select it to try again.');
  }

  add(kind: AddMachineKind, from: HTMLElement): void {
    this.request?.abort(); this.pending.set(null); this.dialogKind.set(kind); this.dialogFrom.set(from);
    this.step.set('host'); this.query.set(''); this.picked.set(null); this.fingerprint.set(''); this.pairText.set(''); this.found.set(null); this.error.set(''); this.loading.set(false); this.dialogOpen.set(true);
  }

  closeDialog(): void { this.request?.abort(); this.loading.set(false); this.dialogOpen.set(false); }
  editHost(query: string): void { this.request?.abort(); this.loading.set(false); this.query.set(query); this.picked.set(null); this.fingerprint.set(''); this.error.set(''); }
  selectHost(host: SshHost): void { this.editHost(host.name); this.picked.set({ name: host.name, user: 'leo', port: 22, auth: 'SSH agent · id_ed25519', fromConfig: true }); }
  resolveHost(query: string): void { this.editHost(query); this.picked.set({ name: query, user: 'leo', port: 22, auth: 'SSH agent' }); }

  async checkKey(): Promise<void> {
    const request = this.beginRequest(); this.loading.set(true);
    await this.delay(request.signal);
    if (request.signal.aborted) return;
    this.loading.set(false); this.fingerprint.set('SHA256:9tQ2kV4fD8mN1pZ0cL7xA3'); this.step.set('key');
  }

  async discover(text: string): Promise<void> {
    const request = this.beginRequest(); this.pairText.set(text); this.found.set(null); this.error.set(''); this.loading.set(!!text.trim());
    if (!text.trim()) return;
    await this.delay(request.signal);
    if (request.signal.aborted) return;
    this.loading.set(false);
    if (text.startsWith('elx-pair:')) this.found.set({ id: 'mini', name: 'Studio Mac', detail: 'Elevenex 1.6.0 · on your network' });
    else this.error.set('Pairing text was not recognized. Copy it again from the other computer.');
  }

  confirm(intent: AddMachineIntent): void {
    this.closeDialog();
    const machine: Machine = { id: `added-${++this.nextMachine}`, name: intent.kind === 'ssh' ? intent.host.name : intent.computer.name, kind: intent.kind, conn: 'idle', color: intent.kind === 'ssh' ? 'ocean' : 'plum', busy: { step: intent.kind === 'ssh' ? 'Installing the engine' : 'Connecting', progress: .12, meta: '12%' } };
    this.machines.update(machines => [...machines, machine]); this.pending.set({ machine, newWindow: false }); this.event.set(`${machine.name} added. Preparation happens on its card.`);
  }

  private launch(event: MachineOpenEvent): void {
    if (event.newWindow) { this.event.set(`Open ${event.machine.name} in a new window (intent only).`); return; }
    this.current.set(event.machine); this.wasOpened.set(true); this.opened.set(true); this.event.set(`Opening ${event.machine.name}.`);
  }
  private beginRequest(): AbortController { this.request?.abort(); const request = new AbortController(); this.request = request; return request; }
  private delay(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, 250); signal.addEventListener('abort', done, { once: true });
    });
  }
}
