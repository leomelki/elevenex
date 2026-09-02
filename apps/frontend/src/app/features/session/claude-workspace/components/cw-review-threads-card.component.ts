import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideLockOpen,
  lucideMessagesSquare,
} from '@ng-icons/lucide';
import type { ReviewChat } from '@/shared/models/review-chat.model';

/**
 * The review discussions started from this turn, surfaced inline in the chat
 * so a side conversation never disappears once you scroll past the diff.
 */
@Component({
  selector: 'cw-review-threads-card',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideChevronRight, lucideLockOpen, lucideMessagesSquare }),
  ],
  template: `
    <section class="cw-threads" aria-label="Review discussions from this turn">
      <header class="cw-threads__head">
        <span class="cw-threads__icon" aria-hidden="true">
          <ng-icon name="lucideMessagesSquare" size="13" />
        </span>
        <span class="cw-threads__title">
          {{ threads().length }}
          {{ threads().length === 1 ? 'review discussion' : 'review discussions' }}
        </span>
        @if (unreadCount() > 0) {
          <span class="cw-threads__unread">{{ unreadCount() }} new</span>
        }
      </header>

      <ul class="cw-threads__list">
        @for (thread of threads(); track thread.id) {
          <li>
            <button type="button" class="cw-threads__item" (click)="open.emit(thread.id)">
              @if (unreadIds().has(thread.id)) {
                <span class="cw-threads__dot" aria-label="New reply"></span>
              }
              <span class="cw-threads__label">{{ thread.title }}</span>
              @if (thread.mode === 'write') {
                <ng-icon name="lucideLockOpen" size="11" class="cw-threads__write" />
              }
              @if (thread.status === 'promoted') {
                <span class="cw-threads__badge">session</span>
              }
              <ng-icon name="lucideChevronRight" size="13" class="cw-threads__chevron" />
            </button>
          </li>
        }
      </ul>
    </section>
  `,
  styles: [
    `
      .cw-threads {
        border: 1px solid color-mix(in oklab, var(--primary) 22%, var(--border));
        border-radius: 0.75rem;
        background: color-mix(in oklab, var(--primary) 5%, var(--card));
        overflow: hidden;
      }

      .cw-threads__head {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 0.7rem;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
      }

      .cw-threads__icon {
        display: inline-flex;
        width: 1.15rem;
        height: 1.15rem;
        align-items: center;
        justify-content: center;
        border-radius: 0.35rem;
        background: color-mix(in oklab, var(--primary) 14%, transparent);
        color: color-mix(in oklab, var(--primary) 85%, var(--foreground));
      }

      .cw-threads__title {
        color: var(--foreground);
        font-size: 0.74rem;
        font-weight: 700;
      }

      .cw-threads__unread {
        margin-left: auto;
        border-radius: 999px;
        background: var(--primary);
        color: var(--primary-foreground);
        font-size: 0.62rem;
        font-weight: 700;
        padding: 0.05rem 0.4rem;
      }

      .cw-threads__list {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0.25rem;
        list-style: none;
      }

      .cw-threads__item {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 0.4rem;
        border: 0;
        border-radius: 0.45rem;
        background: transparent;
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.76rem;
        padding: 0.35rem 0.45rem;
        text-align: left;
        transition: background-color 120ms ease;
      }

      .cw-threads__item:hover,
      .cw-threads__item:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 10%, transparent);
      }

      .cw-threads__item:focus-visible {
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 40%, transparent);
      }

      .cw-threads__dot {
        width: 0.4rem;
        height: 0.4rem;
        flex-shrink: 0;
        border-radius: 999px;
        background: var(--primary);
      }

      .cw-threads__label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
      }

      .cw-threads__write {
        color: var(--warning);
      }

      .cw-threads__badge {
        border-radius: 999px;
        background: color-mix(in oklab, var(--muted) 70%, transparent);
        color: var(--muted-foreground);
        font-size: 0.6rem;
        font-weight: 700;
        padding: 0.05rem 0.35rem;
      }

      .cw-threads__chevron {
        margin-left: auto;
        color: var(--muted-foreground);
      }
    `,
  ],
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
