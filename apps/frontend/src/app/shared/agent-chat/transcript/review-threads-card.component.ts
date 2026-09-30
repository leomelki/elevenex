import type { ReviewChat } from '@/shared/models/review-chat.model';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideLockOpen, lucideMessagesSquare } from '@ng-icons/lucide';

/**
 * The review discussions started from this turn, surfaced inline in the chat
 * so a side conversation never disappears once you scroll past the diff.
 */
@Component({
  selector: 'cw-review-threads-card',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronRight, lucideLockOpen, lucideMessagesSquare })],
  templateUrl: './review-threads-card.component.html',
  styleUrl: './review-threads-card.component.scss',
})
export class ReviewThreadsCardComponent {
  readonly threads = input.required<readonly ReviewChat[]>();
  readonly unreadIds = input<ReadonlySet<number>>(new Set<number>());

  readonly open = output<number>();

  unreadCount(): number {
    const unread = this.unreadIds();
    return this.threads().filter((thread) => unread.has(thread.id)).length;
  }
}
