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
  templateUrl: './claude-context-note.component.html',
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
