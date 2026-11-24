import { ChangeDetectionStrategy, Component, computed, input, linkedSignal, output } from '@angular/core';
import type { SessionAgentSender } from '@elevenex/shared';
import { ButtonComponent, FoldComponent, IconComponent } from '../../ui';
import { AgentMarkComponent } from '../composer/agent-mark.component';
import { agentControl, sessionAgentTitle, type AgentWorkIntent } from './agent-work.models';

@Component({
  selector: 'ex-agent-assignment',
  imports: [AgentMarkComponent, ButtonComponent, FoldComponent, IconComponent],
  templateUrl: './agent-assignment.component.html',
  styleUrl: './agent-assignment.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentAssignmentComponent {
  readonly sender = input.required<SessionAgentSender>();
  readonly text = input.required<string>();
  readonly time = input('');
  readonly controlsDisabled = input(false);
  readonly requested = output<AgentWorkIntent>();
  protected readonly title = computed(() => sessionAgentTitle(this.sender().session));
  protected readonly long = computed(() => this.text().length > 480 || this.text().split('\n', 9).length > 8);
  protected readonly open = linkedSignal({ source: this.long, computation: long => !long });
  protected readonly contentId = 'agent-assignment-' + crypto.randomUUID();

  protected link(event: Event): void {
    this.requested.emit({ target: { kind: 'session', session: this.sender().session }, action: 'return', origin: agentControl(event) });
  }
}
