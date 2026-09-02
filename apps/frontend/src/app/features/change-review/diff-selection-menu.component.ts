import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCopy,
  lucideMessageSquarePlus,
  lucidePlus,
  lucideSparkles,
} from '@ng-icons/lucide';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';

export interface DiffSelectionMenuAction {
  id: string;
  label: string;
  icon: string;
  /** Rendered as the primary, filled button. */
  primary?: boolean;
}

/** What the Changes panel offers on its own: mention the selection in chat. */
export const DEFAULT_DIFF_SELECTION_ACTIONS: readonly DiffSelectionMenuAction[] = [
  { id: 'mention', label: 'Mention in chat', icon: 'lucideMessageSquarePlus' },
];

/**
 * The floating bar shown over a diff text selection.
 *
 * Split out of the panel so the review workspace can offer more than one action
 * without the panel growing a second, near-identical selection implementation —
 * the selection capture itself stays in the panel.
 */
@Component({
  selector: 'cr-selection-menu',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCopy,
      lucideMessageSquarePlus,
      lucidePlus,
      lucideSparkles,
    }),
  ],
  template: `
    <div
      class="cr-selection-menu"
      role="toolbar"
      aria-label="Actions for the selected code"
      [style.top.px]="top()"
      [style.left.px]="left()"
      (mousedown)="$event.preventDefault()"
    >
      @for (action of actions(); track action.id) {
        <button
          type="button"
          class="cr-selection-menu__button"
          [class.cr-selection-menu__button--primary]="action.primary"
          [title]="action.label"
          (click)="invoke.emit({ id: action.id, mentions: mentions() })"
        >
          <ng-icon [name]="action.icon" size="13" />
          <span>{{ action.label }}</span>
        </button>
      }
      @if (mentions().length > 1) {
        <span class="cr-selection-menu__count" [attr.aria-label]="mentions().length + ' files selected'">
          {{ mentions().length }}
        </span>
      }
    </div>
  `,
  styles: [
    `
      .cr-selection-menu {
        position: absolute;
        z-index: 20;
        display: inline-flex;
        align-items: center;
        gap: 0.15rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--popover);
        box-shadow:
          0 1px 2px color-mix(in oklab, var(--foreground) 8%, transparent),
          0 8px 24px color-mix(in oklab, var(--foreground) 12%, transparent);
        padding: 0.2rem;
      }

      .cr-selection-menu__button {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        border: 0;
        border-radius: 0.35rem;
        background: transparent;
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.28rem 0.5rem;
        white-space: nowrap;
        transition:
          background-color 120ms ease,
          color 120ms ease;
      }

      .cr-selection-menu__button:hover,
      .cr-selection-menu__button:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 12%, transparent);
      }

      .cr-selection-menu__button:focus-visible {
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--primary) 45%, transparent);
      }

      .cr-selection-menu__button--primary {
        background: var(--primary);
        color: var(--primary-foreground);
      }

      .cr-selection-menu__button--primary:hover,
      .cr-selection-menu__button--primary:focus-visible {
        background: color-mix(in oklab, var(--primary) 88%, var(--foreground));
      }

      .cr-selection-menu__count {
        margin-left: 0.1rem;
        margin-right: 0.25rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--muted) 70%, transparent);
        color: var(--muted-foreground);
        font-size: 0.65rem;
        font-weight: 700;
        padding: 0.05rem 0.35rem;
      }
    `,
  ],
})
export class DiffSelectionMenuComponent {
  readonly top = input.required<number>();
  readonly left = input.required<number>();
  readonly mentions = input.required<DiffSelectionMention[]>();
  readonly actions = input<readonly DiffSelectionMenuAction[]>(
    DEFAULT_DIFF_SELECTION_ACTIONS,
  );

  readonly invoke = output<{ id: string; mentions: DiffSelectionMention[] }>();
}
