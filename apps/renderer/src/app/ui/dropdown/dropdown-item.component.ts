import { CdkMenuItem, CdkMenuItemRadio } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

// CDK keeps disabled menu items focusable so their labels remain discoverable.
// It sets aria-disabled and blocks activation; native disabled would break its arrow-key traversal.
@Component({
  selector: 'button[exDropdownItem]',
  hostDirectives: [{
    directive: CdkMenuItem,
    inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuitemTypeaheadLabel: typeaheadLabel'],
    outputs: ['cdkMenuItemTriggered: triggered'],
  }],
  host: { type: 'button', '[class.danger]': 'danger()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './dropdown-item.component.css',
})
export class DropdownItemComponent {
  readonly danger = input(false);
}

@Component({
  selector: 'button[exDropdownRadio]',
  imports: [IconComponent],
  hostDirectives: [{
    directive: CdkMenuItemRadio,
    inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuItemChecked: checked', 'cdkMenuitemTypeaheadLabel: typeaheadLabel'],
    outputs: ['cdkMenuItemTriggered: triggered'],
  }],
  host: { type: 'button' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />@if (item.checked) { <ex-icon class="check" name="check" [size]="14" /> }',
  styleUrl: './dropdown-item.component.css',
})
export class DropdownRadioComponent {
  protected readonly item = inject(CdkMenuItemRadio);
}
