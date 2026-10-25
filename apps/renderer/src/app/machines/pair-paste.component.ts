import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FoldComponent, IconComponent } from '../ui';
import { PairedComputer } from './machine.models';

@Component({
  selector: 'ex-pair-paste',
  imports: [FoldComponent, IconComponent],
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
}
