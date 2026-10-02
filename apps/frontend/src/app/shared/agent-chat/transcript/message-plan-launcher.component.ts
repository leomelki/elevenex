import { ZardButtonComponent } from '@/shared/components/button';
import type { PlanReviewRequest } from '@/shared/models/plan-review.model';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFileText, lucideMessageSquarePlus } from '@ng-icons/lucide';

@Component({
  selector: 'cw-message-plan-launcher',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[min(100%,42rem)]' },
  viewProviders: [provideIcons({ lucideFileText, lucideMessageSquarePlus })],
  templateUrl: './message-plan-launcher.component.html',
})
export class MessagePlanLauncherComponent {
  readonly review = input.required<PlanReviewRequest>();
  readonly enabled = input(false);
  readonly openReview = output<PlanReviewRequest>();
  readonly ask = output<PlanReviewRequest>();
}
