import { agentLabel } from '@/shared/agent-tools/agent-label';
import { SubagentIdentityComponent } from '@/shared/agent-chat/activity/subagent-identity.component';
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBot,
  lucideChevronDown,
  lucideArrowUpRight,
  lucideMessageSquare,
  lucideFlag,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { AgentMarkdownComponent } from '../markdown/agent-markdown.component';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { agentRouteLabel } from './agent-message';

@Component({
  selector: 'cw-agent-message',
  imports: [SubagentIdentityComponent, NgIcon, ZardButtonComponent, AgentMarkdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './agent-message.component.html',
  viewProviders: [
    provideIcons({
      lucideBot,
      lucideChevronDown,
      lucideArrowUpRight,
      lucideMessageSquare,
      lucideFlag,
    }),
  ],
})
export class AgentMessageComponent {
  readonly message = input.required<NonNullable<AgentTranscriptItem['agentMessage']>>();
  readonly agents = input<readonly AgentSubagentState[]>([]);
  readonly canInspect = input(false);
  readonly timestamp = input<string | null>(null);
  readonly worktreePath = input<string | null>(null);
  readonly inspect = output<string>();
  readonly openLocalFile = output<LocalFileTarget>();
  readonly expanded = signal(false);
  readonly agent = computed(() =>
    this.agents().find(
      (agent) =>
        agent.agentId === this.message().sender || agent.agentPath === this.message().sender,
    ),
  );
  readonly sender = computed(() =>
    this.agent() ? agentLabel(this.agent()!) : agentRouteLabel(this.message().sender),
  );
  readonly recipient = computed(() =>
    this.message().recipient ? agentRouteLabel(this.message().recipient!) : null,
  );
  readonly preview = computed(() => this.message().body?.replace(/\s+/g, ' ').slice(0, 220));
}
