import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DropdownComponent, type DropdownOption } from '../dropdown';

export type SettingChoice = DropdownOption;

/** Settings adapter; dropdown behavior belongs to ui/dropdown. */
@Component({
  selector: 'ex-set-choice',
  imports: [DropdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ex-dropdown [options]="options()" [value]="value()" [label]="label()" [placeholder]="placeholder()" [mono]="mono()" [icon]="icon()" [disabled]="disabled()" [active]="active()" (changed)="changed.emit($event)" />`,
  styles: ':host { display: inline-flex; min-width: 0; max-width: 100%; }',
})
export class SetChoiceComponent {
  readonly options = input.required<readonly SettingChoice[]>();
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly placeholder = input('Choose…');
  readonly mono = input(false);
  readonly icon = input<string>();
  readonly disabled = input(false);
  readonly active = input(true);
  readonly changed = output<string>();
}
