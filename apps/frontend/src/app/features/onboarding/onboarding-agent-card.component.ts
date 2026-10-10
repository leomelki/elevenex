import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideSparkles, lucideFileText, lucideNotebookPen, lucideTerminal } from '@ng-icons/lucide';
import { AgentProviderPresentation } from '@/shared/models/agent-provider-presentation';

@Component({
  selector: 'app-onboarding-agent-card',
  imports: [NgIcon],
  templateUrl: './onboarding-agent-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideCheck, lucideSparkles, lucideFileText, lucideNotebookPen, lucideTerminal })],
})
export class OnboardingAgentCardComponent {
  readonly provider = input.required<AgentProviderPresentation>();
  readonly description = input.required<string>();
  readonly selected = input(false);
  readonly select = output<void>();
}
