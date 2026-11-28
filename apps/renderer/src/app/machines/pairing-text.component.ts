import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent, IconComponent } from '../ui';

@Component({
  selector: 'ex-pairing-text',
  imports: [ButtonComponent, IconComponent],
  templateUrl: './pairing-text.component.html',
  styleUrl: './pairing-text.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PairingTextComponent {
  readonly text = input.required<string>();
  readonly copied = input(false);
  readonly disabled = input(false);
  readonly copyRequested = output<void>();
}
