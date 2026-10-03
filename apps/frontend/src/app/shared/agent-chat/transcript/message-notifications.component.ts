import type { TaskNotification } from '@/shared/utils/task-notification';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheckCircle, lucideSquare, lucideXCircle } from '@ng-icons/lucide';

@Component({
  selector: 'cw-message-notifications',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-1' },
  viewProviders: [provideIcons({ lucideCheckCircle, lucideSquare, lucideXCircle })],
  templateUrl: './message-notifications.component.html',
})
export class MessageNotificationsComponent {
  readonly notifications = input.required<readonly TaskNotification[]>();
  readonly inline = input(false);
  readonly timestamp = input<string | null>(null);
}
