import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../ui';
import { Machine, MACHINE_ICON } from './machine.models';

@Component({
  selector: 'ex-island-name',
  imports: [IconComponent],
  templateUrl: './island-name.component.html',
  styleUrl: './island-name.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IslandNameComponent {
  readonly machine = input.required<Machine>();
  readonly back = input(false);
  readonly guests = input(0);
  protected readonly icons = MACHINE_ICON;
  protected color(): string { return `var(--project-${this.machine().hue ?? this.machine().color ?? 'ocean'})`; }
}
