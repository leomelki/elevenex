import type { ReviewChat } from '@/shared/models/review-chat.model';
import { ZardButtonComponent } from '@/shared/components/button';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronRight, lucideLockOpen, lucideMessagesSquare } from '@ng-icons/lucide';

/**
 * The review discussions started from this turn, surfaced inline in the chat
 * so a side conversation never disappears once you scroll past the diff.
 */
@Component({
  selector: 'cw-review-threads-card',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronRight, lucideLockOpen, lucideMessagesSquare })],
  templateUrl: './review-threads-card.component.html',
})
export class ReviewThreadsCardComponent {
  readonly threads = input.required<readonly ReviewChat[]>();
  readonly unreadIds = input<ReadonlySet<number>>(new Set<number>());

  readonly open = output<number>();

  readonly unreadCount = computed(() => {
    const unread = this.unreadIds();
    return this.threads().filter((thread) => unread.has(thread.id)).length;
  });
}
