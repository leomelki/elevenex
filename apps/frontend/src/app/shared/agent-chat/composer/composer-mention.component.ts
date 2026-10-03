import { AgentMentionCardComponent } from '../attachments/agent-mention-card.component';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** The same removable context card for session snapshots and selected diff lines. */
@Component({
  selector: 'cw-composer-mention',
  imports: [AgentMentionCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', role: 'listitem' },
  template: `<cw-agent-mention
    [mention]="presentation()"
    [removeLabel]="removeLabel()"
    (remove)="remove.emit()"
  />`,
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
  readonly presentation = computed(() => ({
    icon: this.icon(),
    title: this.title(),
    dirname: this.dirname(),
    lineLabel: this.lineLabel(),
    preview: this.preview(),
    detail: this.detail(),
  }));
}
