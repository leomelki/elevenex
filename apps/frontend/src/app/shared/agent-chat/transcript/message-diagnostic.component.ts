import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideInfo, lucideTriangleAlert } from '@ng-icons/lucide';

@Component({
  selector: 'cw-message-diagnostic',
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block max-w-[min(100%,100ch)]' },
  viewProviders: [provideIcons({ lucideInfo, lucideTriangleAlert })],
  templateUrl: './message-diagnostic.component.html',
})
export class MessageDiagnosticComponent {
  readonly item = input.required<AgentTranscriptItem>();
  readonly timestamp = input<string | null>(null);
  readonly title = computed(() => {
    if (
      /\b(warn(?:ing)?|deprecated|ignoring|malformed|invalid config)\b/i.test(
        this.item().content ?? '',
      )
    )
      return 'Warning';
    return this.item().kind === 'error' ? 'Error' : 'System';
  });
  readonly preview = computed(() => {
    const content = this.item().content?.trim().replace(/\s+/g, ' ') ?? '';
    return content.length > 180 ? `${content.slice(0, 180)}...` : content || 'No details';
  });
}
