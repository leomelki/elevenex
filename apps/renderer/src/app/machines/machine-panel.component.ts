import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { Machine, MachineGuest, MACHINE_ICON } from './machine.models';

@Component({
  selector: 'ex-machine-panel',
  imports: [IconComponent, KbdComponent],
  templateUrl: './machine-panel.component.html',
  styleUrls: ['./island-controls.css', './machine-panel.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachinePanelComponent {
  readonly machine = input.required<Machine>();
  readonly guests = input<readonly MachineGuest[]>([]);
  readonly disabled = input(false);
  readonly highlight = input<'change' | 'new'>();
  readonly changeRequested = output<void>();
  readonly disconnectRequested = output<void>();
  readonly guestDisconnected = output<MachineGuest>();
  readonly newWindow = output<void>();
  protected readonly icons = MACHINE_ICON;
}
