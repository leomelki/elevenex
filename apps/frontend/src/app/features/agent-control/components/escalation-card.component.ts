import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideCheck,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { NavigationService } from '@/shared/services/navigation.service';
import {
  AgentApprovalDecision,
  AgentDeepLinkTarget,
  AgentMissionApproval,
} from '../agent-control.model';

export interface EscalationResolution {
  approvalId: string;
  decision: AgentApprovalDecision;
}

/**
 * Prominent warning-toned escalation card shown when a mission is waiting for a
 * human decision. Renders each pending approval with Approve / Decline actions
 * and an Open affordance to jump to the exact view before deciding.
 */
@Component({
  selector: 'app-escalation-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [
    provideIcons({ lucideArrowUpRight, lucideCheck, lucideTriangleAlert, lucideX }),
  ],
  templateUrl: './escalation-card.component.html',
  styleUrl: './escalation-card.component.scss',
})
export class EscalationCardComponent {
  private readonly navigation = inject(NavigationService);

  readonly approvals = input.required<AgentMissionApproval[]>();
  readonly resolve = output<EscalationResolution>();

  protected readonly pending = computed(() =>
    this.approvals().filter((approval) => approval.status === 'pending'),
  );

  protected hasTarget(target?: AgentDeepLinkTarget): boolean {
    return Boolean(target && (target.sessionId != null || target.projectId != null));
  }

  protected approve(approval: AgentMissionApproval): void {
    this.resolve.emit({ approvalId: approval.id, decision: 'approve' });
  }

  protected decline(approval: AgentMissionApproval): void {
    this.resolve.emit({ approvalId: approval.id, decision: 'decline' });
  }

  protected open(target?: AgentDeepLinkTarget): void {
    if (!target) {
      return;
    }
    if (target.sessionId != null) {
      this.navigation.openSession(target.sessionId);
      return;
    }
    if (target.projectId != null) {
      this.navigation.revealProject(target.projectId);
    }
  }
}
