import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { ZardButtonComponent } from '../button/button.component';

@Component({
  selector: 'app-inline-action-confirmation',
  imports: [ZardButtonComponent],
  templateUrl: './inline-action-confirmation.component.html',
  styleUrl: './inline-action-confirmation.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex w-full items-center justify-end gap-[.35rem]',
    '[attr.data-session-delete-controls]': "action() === 'delete' ? 'true' : null",
    '[attr.data-session-archive-controls]': "action() === 'archive' ? 'true' : null",
  },
})
export class InlineActionConfirmationComponent {
  readonly action = input<'delete' | 'archive'>('archive');
  readonly targetId = input.required<number>();
  readonly scope = input<'session' | 'folder'>('session');
  readonly ready = input(false);
  readonly busy = input(false);
  readonly confirm = output<Event>();
  readonly cancel = output<Event>();
  private readonly cancelButton = viewChild<unknown, ElementRef<HTMLButtonElement>>(
    'cancelButton',
    { read: ElementRef },
  );

  constructor() {
    afterNextRender(() => this.cancelButton()?.nativeElement.focus({ preventScroll: true }));
  }

  confirmAction(event: Event): void {
    event.stopPropagation();
    if (this.ready() && !this.busy()) this.confirm.emit(event);
  }

  cancelAction(event: Event): void {
    event.stopPropagation();
    if (!this.busy()) this.cancel.emit(event);
  }
}
