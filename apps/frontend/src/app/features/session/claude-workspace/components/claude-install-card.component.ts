import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { AgentAuthStatus } from '@/shared/models/agent-runtime.model';

@Component({
  selector: 'cw-claude-install-card',
  standalone: true,
  templateUrl: './claude-install-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClaudeInstallCardComponent {
  readonly status = input<AgentAuthStatus | null>(null);
  readonly recheck = output<void>();
}
