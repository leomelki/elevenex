import { ZardButtonComponent } from '@/shared/components/button';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileCode, lucideMessageSquare, lucideX } from '@ng-icons/lucide';

export interface AgentMentionPresentation {
  readonly icon: 'lucideFileCode' | 'lucideMessageSquare';
  readonly title: string;
  readonly dirname?: string;
  readonly lineLabel: string;
  readonly preview: string;
  readonly detail: string;
}

/** Context references share one card in the composer and the saved transcript. */
@Component({
  selector: 'cw-agent-mention',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  viewProviders: [provideIcons({ lucideFileCode, lucideMessageSquare, lucideX })],
  templateUrl: './agent-mention-card.component.html',
})
export class AgentMentionCardComponent {
  readonly mention = input.required<AgentMentionPresentation>();
  readonly removeLabel = input<string | null>(null);
  readonly remove = output<void>();
}
