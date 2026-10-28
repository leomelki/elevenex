import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { ButtonComponent, IconComponent, StatusGlyphComponent } from '../../ui';
import type { CloseTaskIntent } from '../task.models';
import { LinkChipComponent } from './link-chip.component';
import { ModalLayerComponent } from '../../ui/sheet/modal-layer.component';
@Component({
  selector: 'ex-close-task',
  imports: [
    A11yModule,
    ButtonComponent,
    IconComponent,
    StatusGlyphComponent,
    LinkChipComponent,
    ModalLayerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './close-task.component.html',
  styleUrl: './close-task.component.css',
})
export class CloseTaskComponent {
  readonly open = input(true);
  readonly title = input.required<string>();
  readonly sessions = input(0);
  readonly running = input(0);
  readonly unpushed = input(0);
  readonly uncommitted = input(0);
  readonly ticket = input<string>();
  readonly terminals = input(0);
  readonly actions = input(0);
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly confirmed = output<CloseTaskIntent>();
  readonly cancelled = output<void>();
  protected readonly moveTicket = signal(true);
  protected confirm(push: boolean): void {
    if (this.busy()) return;
    this.confirmed.emit({
      push,
      moveTicket: !!this.ticket() && this.moveTicket(),
    });
  }
}
