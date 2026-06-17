import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUpRight, lucideTriangleAlert } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { AgentLiveApproval } from '../agent-channel-websocket.service';

/** Emitted when the user picks an option on a live escalation. */
export interface LiveEscalationResolution {
  approvalId: string;
  decision: string;
}

/**
 * Warning-toned card for a single live, blocking escalation from the meta-agent.
 * Renders the title/detail, the agent's option buttons (first = primary, the
 * rest outline; the canonical approve/deny pair is tone-mapped to success/
 * destructive), and an Open affordance when a deep link is present.
 */
@Component({
  selector: 'app-live-escalation-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [provideIcons({ lucideArrowUpRight, lucideTriangleAlert })],
  templateUrl: './live-escalation-card.component.html',
  styleUrl: './live-escalation-card.component.scss',
})
export class LiveEscalationCardComponent {
  readonly approval = input.required<AgentLiveApproval>();
  readonly resolve = output<LiveEscalationResolution>();
  readonly open = output<string>();

  protected readonly options = computed(() => {
    const options = this.approval().options ?? [];
    return options.map((option, index) => ({
      value: option,
      label: this.titleCase(option),
      zType: this.zTypeFor(option, index),
    }));
  });

  protected onResolve(decision: string): void {
    this.resolve.emit({ approvalId: this.approval().id, decision });
  }

  protected onOpen(): void {
    const deepLink = this.approval().deepLink;
    if (deepLink) {
      this.open.emit(deepLink);
    }
  }

  private zTypeFor(option: string, index: number): 'default' | 'outline' | 'destructive' {
    const normalized = option.toLowerCase();
    if (normalized === 'approve' || normalized === 'proceed' || normalized === 'allow') {
      return 'default';
    }
    if (
      normalized === 'deny' ||
      normalized === 'stop' ||
      normalized === 'reject' ||
      normalized === 'cancel'
    ) {
      return 'destructive';
    }
    // First option is the primary action; everything else is a secondary outline.
    return index === 0 ? 'default' : 'outline';
  }

  private titleCase(value: string): string {
    if (!value) {
      return value;
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
