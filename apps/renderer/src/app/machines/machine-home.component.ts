import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, IconComponent, KbdComponent } from '../ui';
import { MachineCardComponent } from './machine-card.component';
import { Machine, MachineOpenEvent, machineConnected } from './machine.models';

@Component({
  selector: 'ex-machine-home',
  imports: [ButtonComponent, IconComponent, KbdComponent, MachineCardComponent],
  templateUrl: './machine-home.component.html',
  styleUrl: './machine-home.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineHomeComponent {
  readonly machines = input<readonly Machine[]>([]);
  readonly highlighted = input<string>();
  readonly pressed = input<string>();
  readonly title = input('Machines');
  readonly subtitle = input('Pick where this window runs');
  readonly opened = output<MachineOpenEvent>();
  readonly addServer = output<void>();
  readonly pairComputer = output<void>();
  protected readonly query = signal('');
  protected readonly findInput = viewChild<ElementRef<HTMLInputElement>>('findInput');
  protected readonly filtered = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    return this.machines().filter(machine => !query || `${machine.name} ${machine.address ?? ''}`.toLocaleLowerCase().includes(query));
  });
  protected readonly connected = computed(() => this.filtered().filter(machineConnected));
  protected readonly disconnected = computed(() => this.filtered().filter(machine => !machineConnected(machine)));

  protected keydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      this.findInput()?.nativeElement.focus();
    }
    if (event.key === 'Enter' && event.target === this.findInput()?.nativeElement) {
      const machine = this.filtered().find(item => item.id === this.highlighted()) ?? this.connected()[0] ?? this.disconnected()[0];
      if (machine) {
        event.preventDefault();
        this.opened.emit({ machine, newWindow: event.metaKey || event.ctrlKey });
      }
    }
  }
}
