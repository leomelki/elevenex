import { ZardButtonComponent } from '@/shared/components/button';
import type { SessionFork } from '@/shared/models/session.model';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucidePlus } from '@ng-icons/lucide';
import { formatMessageTimestamp } from './message-timestamp';

@Component({
  selector: 'cw-message-forks',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-[min(100%,28rem)] mt-1.5' },
  viewProviders: [provideIcons({ lucideExternalLink, lucidePlus })],
  templateUrl: './message-forks.component.html',
})
export class MessageForksComponent {
  readonly forks = input.required<readonly SessionFork[]>();
  readonly canFork = input(false);
  readonly forkDisabled = input(false);
  readonly rows = computed(() =>
    this.forks().map((fork) => ({
      fork,
      name: fork.childSession?.name || `Session ${fork.childSessionId}`,
      detail: `${fork.childSession?.status || 'deleted'} · ${formatMessageTimestamp(fork.createdAt)}`,
    })),
  );
  readonly open = output<SessionFork>();
  readonly forkAgain = output<void>();
}
