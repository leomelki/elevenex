import { CdkMenu } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A menu surface; the owning feature supplies its trigger and typed actions. */
@Component({
  selector: 'ex-dropdown-menu',
  hostDirectives: [CdkMenu],
  host: { '[attr.aria-label]': 'label()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<ng-content />',
  styleUrl: './dropdown-menu.component.css',
})
export class DropdownMenuComponent {
  readonly label = input.required<string>();
}
