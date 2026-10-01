import { ZardButtonComponent } from '@/shared/components/button';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileCode, lucideMessageSquare, lucideX } from '@ng-icons/lucide';

/** The same removable context card for session snapshots and selected diff lines. */
@Component({
  selector: 'cw-composer-mention',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'listitem' },
  viewProviders: [provideIcons({ lucideFileCode, lucideMessageSquare, lucideX })],
  templateUrl: './composer-mention.component.html',
})
export class ComposerMentionComponent {
  readonly icon = input<'lucideFileCode' | 'lucideMessageSquare'>('lucideFileCode');
  readonly title = input.required<string>();
  readonly dirname = input('');
  readonly lineLabel = input.required<string>();
  readonly preview = input.required<string>();
  readonly detail = input.required<string>();
  readonly removeLabel = input.required<string>();
  readonly remove = output<void>();
}
