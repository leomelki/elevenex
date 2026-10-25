import { afterRenderEffect, ChangeDetectionStrategy, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { IconComponent, KbdComponent } from '../ui';
import { Machine, MachineGuest, MACHINE_ICON } from './machine.models';

@Component({
  selector: 'ex-machine-panel',
  imports: [IconComponent, KbdComponent],
  templateUrl: './machine-panel.component.html',
  styleUrls: ['./island-controls.css', './machine-panel.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachinePanelComponent {
  readonly machine = input.required<Machine>();
  readonly guests = input<readonly MachineGuest[]>([]);
  readonly disabled = input(false);
  readonly highlight = input<'change' | 'new'>();
  readonly changeRequested = output<void>();
  readonly disconnectRequested = output<void>();
  readonly guestDisconnected = output<MachineGuest>();
  readonly newWindow = output<void>();
  protected readonly icons = MACHINE_ICON;
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private wasDisabled = false;

  constructor() {
    afterRenderEffect(() => {
      const disabled = this.disabled();
      const panel = this.panel()?.nativeElement;
      // Disabling a focused native button moves focus to the document body.
      // Keep a keyboard destination inside the island while all actions wait.
      if (disabled && !this.wasDisabled && panel &&
        (document.activeElement === document.body || panel.contains(document.activeElement))) {
        panel.focus({ preventScroll: true });
      }
      this.wasDisabled = disabled;
    });
  }
}
