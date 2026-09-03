import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';

/**
 * A collapsed one-line note above a transcript, expandable for the detail.
 *
 * Used for anything that explains what the agent already knows before the
 * visible conversation starts — the worktree context attached to a first
 * prompt, or the conversation an embedded discussion was forked from.
 *
 * The leading icon and the expanded body are projected so callers keep their
 * own icon providers and their own detail markup.
 */
@Component({
  selector: 'cw-context-note',
  standalone: true,
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronDown })],
  template: `
    <section
      [attr.data-open]="expanded() || null"
      class="group/note rounded-xl border border-border/85 bg-card/92 overflow-hidden transition-[border-color,box-shadow] duration-[160ms] ease-in-out hover:border-primary/22 data-[open]:shadow-[0_10px_28px_-22px_color-mix(in_oklab,var(--foreground)_45%,transparent)]"
      [attr.aria-label]="ariaLabel() || label()"
    >
      <button
        type="button"
        class="flex items-center gap-[0.55rem] w-full pl-[0.85rem] pr-[0.7rem] py-2 border-0 bg-transparent text-foreground font-[inherit] text-left cursor-pointer transition-[background-color] duration-[140ms] hover:bg-foreground/3 focus-visible:outline-none focus-visible:bg-foreground/3"
        [attr.aria-expanded]="expanded()"
        (click)="expanded.set(!expanded())"
      >
        <span
          class="inline-flex items-center justify-center w-[1.15rem] h-[1.15rem] shrink-0 rounded-[0.35rem] bg-primary/14 text-[color-mix(in_oklab,var(--primary)_85%,var(--foreground))]"
          aria-hidden="true"
        >
          <ng-content select="[note-icon]" />
        </span>
        <span
          class="text-[0.68rem] font-semibold tracking-[0.06em] uppercase text-[color-mix(in_oklab,var(--primary)_72%,var(--muted-foreground))] shrink-0"
          >{{ label() }}</span
        >
        <span
          class="text-[0.8rem] leading-[1.4] text-foreground min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis group-data-[open]/note:hidden"
          >{{ summary() }}</span
        >
        <ng-content select="[note-chip]" />
        <ng-icon
          class="text-muted-foreground shrink-0 ml-auto transition-transform duration-[180ms] group-data-[open]/note:rotate-180"
          name="lucideChevronDown"
          size="12"
          aria-hidden="true"
        />
      </button>
      @if (expanded()) {
        <div
          class="flex flex-col gap-[0.55rem] px-[0.95rem] pt-[0.7rem] pb-[0.85rem] border-t border-dashed border-border/70 mt-[0.15rem]"
        >
          <ng-content />
        </div>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
    `,
  ],
})
export class ClaudeContextNoteComponent {
  /** Short uppercase eyebrow, e.g. "Context". */
  readonly label = input.required<string>();
  /** The one-liner shown while collapsed. */
  readonly summary = input.required<string>();
  readonly ariaLabel = input<string>('');

  readonly expanded = signal(false);
}
