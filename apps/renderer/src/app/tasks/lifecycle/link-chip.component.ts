import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { IconComponent } from '../../ui';
@Component({
  selector: 'ex-link-chip',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './link-chip.component.html',
  styleUrl: './link-chip.component.css',
})
export class LinkChipComponent {
  readonly kind = input<'pr' | 'ticket'>('pr');
  readonly label = input.required<string>();
  readonly state = input<string>();
  readonly href = input<string>();
  readonly compact = input(false);
  readonly activated = output<void>();
  protected readonly word = computed(() =>
    this.kind() === 'ticket'
      ? this.state()
      : ((
          {
            draft: 'Draft',
            open: 'Open',
            approved: 'Approved',
            failing: 'Checks failing',
            merged: 'Merged',
            closed: 'Closed',
          } as Readonly<Record<string, string>>
        )[this.state() ?? ''] ?? this.state()),
  );
  protected readonly description = computed(
    () =>
      `${this.kind() === 'pr' ? 'Pull request' : 'Ticket'} ${this.label()}${this.word() ? ` · ${this.word()}` : ''}`,
  );
}
