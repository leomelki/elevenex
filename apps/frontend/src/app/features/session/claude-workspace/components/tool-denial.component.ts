import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShieldX } from '@ng-icons/lucide';
import { ZardCardComponent } from '@/shared/components/card';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { describeAgentTool } from '@/shared/agent-tools/agent-tool-format';
import { toolDenialReason, toolDenialBatch } from '../util/tool-denial';

@Component({
  selector: 'cw-tool-denial',
  imports: [DatePipe, NgIcon, ZardCardComponent],
  viewProviders: [provideIcons({ lucideShieldX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tool-denial.component.html',
  host: { class: 'block min-w-0' },
})
export class ToolDenialComponent {
  readonly call = input.required<ClaudeTranscriptItem>();
  readonly reason = computed(() => toolDenialReason(this.call()));
  readonly display = computed(() => describeAgentTool(this.call()));
  readonly batchCount = computed(() => toolDenialBatch(this.call()).length);
  readonly resolvedAt = computed(() => this.call().interaction?.resolvedAt);
  readonly label = computed(() => {
    if (this.batchCount() > 1) return `You denied ${this.batchCount()} tool calls`;
    switch (this.call().interaction?.kind) {
      case 'ask_user_question':
        return 'You declined this question';
      case 'plan_mode':
        return 'You declined planning';
      case 'exit_plan_mode':
        return 'You requested more planning';
      default:
        return 'You denied this tool';
    }
  });
}
