import { ZardButtonComponent } from '@/shared/components/button';
import { ZardPopoverComponent, ZardPopoverDirective } from '@/shared/components/popover';
import { AgentContextUsage, AgentProviderId } from '@/shared/models/agent-runtime.model';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'cw-context-usage',
  imports: [
    ZardButtonComponent,
    ZardPopoverComponent,
    ZardPopoverDirective,
    CdkTrapFocus,
    DecimalPipe,
  ],
  templateUrl: './context-usage.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0' },
})
export class ContextUsageComponent {
  readonly usage = input.required<AgentContextUsage>();
  readonly provider = input<AgentProviderId>('claude');
  readonly hasBreakdown = computed(
    () => this.usage().tokenBreakdownAvailable ?? this.provider() !== 'pi',
  );
  readonly rows = computed(() => {
    const usage = this.usage();
    return [
      { label: 'Input tokens', value: usage.inputTokens },
      { label: 'Output tokens', value: usage.outputTokens },
      { label: 'Cache read', value: usage.cacheReadInputTokens },
      { label: 'Cache write', value: usage.cacheCreationInputTokens },
    ];
  });
}
