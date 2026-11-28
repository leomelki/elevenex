import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '../ui';
import { AddMachineKind } from './machine.models';

/** Shares the machine-card surface; only its dashed appearance and content differ. */
@Component({
  selector: 'ex-machine-add',
  imports: [IconComponent],
  templateUrl: './machine-add.component.html',
  styleUrl: './machine-card.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineAddComponent {
  readonly kind = input.required<AddMachineKind>();
  readonly requested = output<HTMLElement>();
}
