import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent, StatusGlyphComponent } from '../../ui';

@Component({
  selector: 'ex-machine-error-dialog',
  imports: [ButtonComponent, StatusGlyphComponent],
  templateUrl: './machine-error-dialog.component.html',
  styleUrl: './machine-error-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'dialog', 'aria-labelledby': 'machine-error-title' },
})
export class MachineErrorDialogComponent {
  readonly name = input.required<string>();
  readonly message = input.required<string>();
  readonly active = input(true);
  readonly closed = output<void>();
}
