import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import { IconComponent, KbdComponent, ProgressLineComponent } from '../ui';
import { Machine, MachineOpenEvent, MACHINE_ICON, machineConnected } from './machine.models';

@Component({
  selector: 'ex-machine-card',
  imports: [IconComponent, KbdComponent, ProgressLineComponent],
  templateUrl: './machine-card.component.html',
  styleUrl: './machine-card.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineCardComponent {
  readonly machine = input.required<Machine>();
  readonly highlighted = input(false);
  readonly pressed = input(false);
  readonly disabled = input(false);
  readonly pending = input(false);
  readonly opened = output<MachineOpenEvent>();
  protected readonly icons = MACHINE_ICON;
  protected readonly connected = computed(() => !this.machine().busy && machineConnected(this.machine()));
  protected readonly color = computed(() => this.machine().color ? `var(--project-${this.machine().color})` : 'var(--ink)');
  protected readonly settled = linkedSignal({
    source: () => ({ id: this.machine().id, busy: !!this.machine().busy }),
    computation: ({ id, busy }, previous): boolean => !busy && previous?.source.id === id && (previous.source.busy || previous.value),
  });
  protected readonly line = computed(() => ({
    key: this.machine().busy ? `busy-${this.machine().busy!.step}` : this.settled() ? 'ready' : 'initial',
    text: this.description(), meta: this.machine().busy?.meta,
  }));
  protected readonly description = computed(() => {
    const machine = this.machine();
    return machine.busy?.step ?? (machine.update ? `Had ${machine.update} · updates when opened` : this.connected() ? machine.status ?? 'Connected' : machine.last ?? 'Not connected');
  });

  protected open(event: MouseEvent): void {
    if (this.disabled()) return;
    this.opened.emit({ machine: this.machine(), newWindow: event.metaKey || event.ctrlKey });
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || this.disabled()) return;
    // Native keyboard-generated clicks do not preserve the modifier keys.
    event.preventDefault();
    this.opened.emit({ machine: this.machine(), newWindow: true });
  }
}
