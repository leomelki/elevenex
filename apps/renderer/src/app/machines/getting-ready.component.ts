import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent, ProgressLineComponent, StatusGlyphComponent } from '../ui';
import { ReadyStep } from './machine.models';

@Component({
  selector: 'ex-getting-ready',
  imports: [IconComponent, ProgressLineComponent, StatusGlyphComponent],
  templateUrl: './getting-ready.component.html',
  styleUrl: './getting-ready.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GettingReadyComponent {
  readonly icon = input('server');
  readonly title = input.required<string>();
  readonly sub = input('');
  readonly steps = input<readonly ReadyStep[]>([]);
  readonly note = input('');
}
