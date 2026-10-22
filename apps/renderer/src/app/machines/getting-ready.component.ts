import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent, StatusGlyphComponent } from '../ui';
import { ReadyStep } from './machine.models';

@Component({
  selector: 'ex-getting-ready',
  imports: [IconComponent, StatusGlyphComponent],
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
  protected progress(value: number | undefined): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value ?? 0)) : 0;
  }
}
