import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBot, lucideSend, lucideSquare, lucideTimer } from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { AgentMarkdownComponent } from '../markdown/agent-markdown.component';
import { SubagentStatusComponent } from '../activity/subagent-status.component';
import { claudeDelegationView } from '@/shared/agent-tools/claude-delegation-format';
import type { AgentSubagentState, AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';

@Component({
  selector: 'cw-claude-delegation',
  imports: [JsonPipe, NgIcon, ZardButtonComponent, AgentMarkdownComponent, SubagentStatusComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-delegation.component.html',
  viewProviders: [provideIcons({ lucideBot, lucideSend, lucideSquare, lucideTimer })],
})
export class ClaudeDelegationComponent {
  readonly call = input.required<AgentTranscriptItem>();
  readonly result = input<AgentTranscriptItem | null>(null);
  readonly agents = input<ReadonlyMap<string, AgentSubagentState>>();
  readonly isLive = input(false);
  readonly canInspect = input(false);
  readonly worktreePath = input<string | null>(null);
  readonly inspectAgent = output<string>();
  readonly openLocalFile = output<LocalFileTarget>();
  readonly view = computed(() => claudeDelegationView(this.call(), this.result(), this.agents()));
}
