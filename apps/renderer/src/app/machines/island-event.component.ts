import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IconComponent } from '../ui';

@Component({
  selector: 'ex-island-event',
  imports: [IconComponent],
  templateUrl: './island-event.component.html',
  styleUrls: ['./island-controls.css', './island-event.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IslandEventComponent {
  readonly icon = input('peer');
  readonly title = input.required<string>();
  readonly sub = input('');
  readonly action = input('');
  readonly actionRequested = output<void>();
}
