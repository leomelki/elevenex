import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, IconComponent, KbdComponent } from '../ui';
import { MachineAddComponent } from './machine-add.component';
import { MachineCardComponent } from './machine-card.component';
import { MachineGridMotionDirective } from './machine-grid-motion.directive';
import { MACHINE_LAUNCH_OPEN } from './machine-launch-context';
import { Machine, MachineOpenEvent, machineConnected } from './machine.models';

type HomeEntry = { readonly key: string; readonly machine: Machine } | { readonly key: string; readonly label: string };

@Component({
  selector: 'ex-machine-home',
  imports: [ButtonComponent, IconComponent, KbdComponent, MachineCardComponent, MachineAddComponent, MachineGridMotionDirective],
  templateUrl: './machine-home.component.html',
  styleUrl: './machine-home.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineHomeComponent {
  readonly machines = input<readonly Machine[]>([]);
  readonly highlighted = input<string>();
  readonly pressed = input<string>();
  readonly pending = input<string | readonly string[] | null>(null);
  readonly firstRun = input(false);
  readonly title = input<string>();
  readonly subtitle = input<string>();
  readonly opened = output<MachineOpenEvent>();
  readonly addServer = output<HTMLElement>();
  readonly pairComputer = output<HTMLElement>();
  protected readonly query = signal('');
  protected readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  private readonly launchOpen = inject(MACHINE_LAUNCH_OPEN, { optional: true });
  protected readonly held = computed(() => !!this.launchOpen?.());
  protected readonly showFirstRun = linkedSignal({ source: () => ({ firstRun: this.firstRun(), held: this.held() }), computation: ({ firstRun, held }, previous): boolean => held && previous ? previous.value : firstRun });
  protected readonly heading = computed(() => this.title() ?? (this.showFirstRun() ? 'Where should your agents run?' : 'Machines'));
  protected readonly description = computed(() => this.subtitle() ?? (this.showFirstRun() ? 'Open a machine to work on it. Add more any time: they all wait here.' : 'Pick where this window runs'));
  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.machines().filter(machine => !query || `${machine.name} ${machine.address ?? ''}`.toLocaleLowerCase().includes(query));
  });
  // Placement is local interaction state. Keep an existing group while preparing,
  // pending or behind the machine view; release it when Home becomes visible.
  private readonly groups = linkedSignal({
    source: () => ({ machines: this.machines(), pending: this.pending(), held: this.held() }),
    computation: ({ machines, held }, previous): ReadonlyMap<string, boolean> => new Map(machines.map(machine => {
      const before = previous?.value.get(machine.id);
      return [machine.id, before !== undefined && (held || machine.busy || this.isPending(machine.id)) ? before : machineConnected(machine)];
    })),
  });
  protected readonly entries = computed<readonly HomeEntry[]>(() => {
    const machines = this.filtered();
    if (this.showFirstRun()) return machines.map(machine => ({ key: `machine:${machine.id}`, machine }));
    const entries: HomeEntry[] = [];
    for (const connected of [true, false]) {
      const group = machines.filter(machine => this.groups().get(machine.id) === connected);
      if (group.length) entries.push({ key: `group:${connected}`, label: connected ? 'Connected' : 'Not connected' }, ...group.map(machine => ({ key: `machine:${machine.id}`, machine })));
    }
    return entries;
  });
  protected readonly gridKeys = computed(() => this.entries().map(entry => entry.key), {
    equal: (previous, next) => previous.length === next.length && previous.every((key, index) => key === next[index]),
  });

  protected isPending(id: string): boolean {
    const pending = this.pending();
    return typeof pending === 'string' ? pending === id : !!pending?.includes(id);
  }

  protected add(event: MouseEvent, kind: 'ssh' | 'peer'): void {
    if (event.currentTarget instanceof HTMLElement) (kind === 'ssh' ? this.addServer : this.pairComputer).emit(event.currentTarget);
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      this.findInput()?.nativeElement.focus();
    }
    if (event.key === 'Enter' && event.target === this.findInput()?.nativeElement) {
      const machines = this.entries().flatMap(entry => 'machine' in entry ? [entry.machine] : []);
      const machine = machines.find(item => item.id === this.highlighted()) ?? machines[0];
      if (machine) {
        event.preventDefault();
        this.opened.emit({ machine, newWindow: event.metaKey || event.ctrlKey });
      }
    }
  }
}
