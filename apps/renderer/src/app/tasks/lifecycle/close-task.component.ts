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
@Component({
  selector: 'ex-close-task',
  imports: [
    A11yModule,
    ButtonComponent,
    IconComponent,
    StatusGlyphComponent,
    LinkChipComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './close-task.component.html',
  styleUrl: './close-task.component.css',
})
export class CloseTaskComponent {
  readonly title = input.required<string>();
  readonly sessions = input(0);
  readonly running = input(0);
  readonly unpushed = input(0);
  readonly ticket = input<string>();
  readonly confirmed = output<CloseTaskIntent>();
  readonly cancelled = output<void>();
  protected readonly moveTicket = signal(true);
  protected confirm(push: boolean): void {
    this.confirmed.emit({
      push,
      moveTicket: !!this.ticket() && this.moveTicket(),
    });
  }
}
