import type { MessageLoadEvent } from '@/shared/utils/user-message-display';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBookOpen, lucideImage } from '@ng-icons/lucide';

@Component({
  selector: 'cw-message-loads',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-1' },
  viewProviders: [provideIcons({ lucideBookOpen, lucideImage })],
  templateUrl: './message-loads.component.html',
})
export class MessageLoadsComponent {
  readonly loads = input.required<readonly MessageLoadEvent[]>();
  readonly timestamp = input<string | null>(null);
}
