import { CdkContextMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, afterRenderEffect, input, output, viewChild } from '@angular/core';
import { MachineMenuComponent, MachineMenuAction } from './machine-menu.component';
import { MachineMenuEvent } from './machine.models';

/** One window-level CDK menu. The request retains the card for Edit's morph. */
@Component({
  selector: 'ex-machine-menu-popup',
  imports: [CdkContextMenuTrigger, MachineMenuComponent],
  template: `<span #button="cdkContextMenuTriggerFor" [cdkContextMenuTriggerFor]="menu" [cdkContextMenuPosition]="buttonPositions" (cdkContextMenuClosed)="close(true)"></span>
    <span #context="cdkContextMenuTriggerFor" [cdkContextMenuTriggerFor]="menu" (cdkContextMenuClosed)="close(false)"></span>
    <ng-template #menu>@if (request(); as event) { <ex-machine-menu [machine]="event.machine" [autofocus]="true" (action)="act($event)" /> }</ng-template>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachineMenuPopupComponent {
  readonly request = input<MachineMenuEvent | null>(null);
  readonly action = output<{ readonly event: MachineMenuEvent; readonly action: MachineMenuAction }>();
  readonly closed = output<void>();
  protected readonly buttonPositions = [
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'bottom' },
  ] as const;
  // CDK retains an overlay's positioning strategy after close. Separate triggers
  // keep the button's end alignment and the pointer's start alignment independent.
  private readonly button = viewChild<CdkContextMenuTrigger>('button');
  private readonly context = viewChild<CdkContextMenuTrigger>('context');
  private origin: MachineMenuEvent | null = null;

  constructor() {
    afterRenderEffect(() => {
      const event = this.request(), button = this.button(), context = this.context();
      if (event) {
        this.origin = event;
        (event.fromButton ? context : button)?.close();
        (event.fromButton ? button : context)?.open({ x: event.x, y: event.y });
      } else { button?.close(); context?.close(); }
    });
  }

  protected close(fromButton: boolean): void {
    const event = this.origin;
    if (!event || event.fromButton !== fromButton || this.request() && this.request() !== event) return;
    const focused = event?.card.ownerDocument.activeElement;
    if (event && (focused === event.card.ownerDocument.body || focused?.closest('[role="menu"]'))) this.returnFocus(event);
    this.origin = null; this.closed.emit();
  }

  private returnFocus(event: MachineMenuEvent): void {
    (event.fromButton ? event.card.parentElement?.querySelector<HTMLButtonElement>('.more') : event.card)?.focus({ preventScroll: true });
  }

  protected act(action: MachineMenuAction): void {
    const event = this.request();
    if (!event) return;
    // Supply a real return target before the modal captures its opener.
    this.returnFocus(event);
    this.action.emit({ event, action });
  }
}
