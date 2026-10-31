import { ChangeDetectionStrategy, Component, afterNextRender, input, output, viewChild } from '@angular/core';
import { CdkMenu } from '@angular/cdk/menu';
import { DropdownMenuComponent, DropdownItemComponent, IconComponent, KbdComponent } from '../ui';
import { Machine, machineConnected } from './machine.models';

export type MachineMenuAction = 'edit' | 'new-window' | 'disconnect' | 'remove' | 'details';

/** Supplied menu content; compose with a CDK trigger or MachineMenuPopup. */
@Component({
  selector: 'ex-machine-menu',
  imports: [DropdownMenuComponent, DropdownItemComponent, IconComponent, KbdComponent],
  templateUrl: './machine-menu.component.html',
  styleUrl: './machine-menu.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineMenuComponent {
  readonly machine = input.required<Machine>();
  readonly disabled = input(false);
  readonly autofocus = input(false);
  readonly action = output<MachineMenuAction>();
  protected readonly connected = machineConnected;
  private readonly menu = viewChild(CdkMenu);
  constructor() { afterNextRender(() => { if (this.autofocus()) this.menu()?.focusFirstItem('program'); }); }
}
