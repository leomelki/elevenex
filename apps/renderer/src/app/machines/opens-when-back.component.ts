import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent, IconComponent } from '../ui';

/** A content boundary for data this window has never loaded. */
@Component({
  selector: 'ex-opens-when-back',
  imports: [ButtonComponent, IconComponent],
  templateUrl: './opens-when-back.component.html',
  styleUrl: './opens-when-back.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.compact]': 'compact()' },
})
export class OpensWhenBackComponent {
  readonly machine = input.required<string>();
  readonly what = input('This view');
  readonly compact = input(false);
  readonly backLabel = input('');
  readonly tryRequested = output<void>();
  readonly backRequested = output<void>();
}
