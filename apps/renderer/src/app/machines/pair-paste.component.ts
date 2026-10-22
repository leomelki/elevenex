import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent } from '../ui';
import { PairedComputer } from './machine.models';

@Component({
  selector: 'ex-pair-paste',
  imports: [ButtonComponent, FoldComponent, IconComponent],
  templateUrl: './pair-paste.component.html',
  styleUrl: './pair-paste.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PairPasteComponent {
  readonly text = input('');
  readonly found = input<PairedComputer | null>(null);
  readonly finding = input(false);
  readonly disabled = input(false);
  readonly error = input('');
  readonly textChange = output<string>();
  readonly paired = output<PairedComputer>();
  readonly back = output<void>();
  protected pair(): void {
    const found = this.found();
    if (found && !this.disabled() && !this.finding() && !this.error()) this.paired.emit(found);
  }
}
