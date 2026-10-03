import { ZardButtonComponent } from '@/shared/components/button';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
  lucideCopy,
  lucideGitFork,
  lucideLoaderCircle,
  lucidePencil,
  lucideX,
} from '@ng-icons/lucide';

export interface MessageActionState {
  readonly copy: boolean;
  readonly edit: boolean;
  readonly fork: boolean;
  readonly disabled: boolean;
  readonly editArmed: boolean;
  readonly forkDisabled: boolean;
  readonly forkDisabledReason: string;
  readonly forking: boolean;
}

/** The same accessible actions and fork marker for user and assistant messages. */
@Component({
  selector: 'cw-message-actions',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'user() ? "absolute right-0 top-[calc(100%-1.2rem)] whitespace-nowrap" : "block"',
  },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideCopy,
      lucideGitFork,
      lucideLoaderCircle,
      lucidePencil,
      lucideX,
    }),
  ],
  templateUrl: './message-actions.component.html',
})
export class MessageActionsComponent {
  readonly state = input.required<MessageActionState>();
  readonly user = input(false);
  readonly timestamp = input<string | null>(null);
  readonly forkCount = input(0);
  readonly forksExpanded = input(false);
  readonly forkCountLabel = computed(
    () => `${this.forkCount()} fork${this.forkCount() === 1 ? '' : 's'}`,
  );
  readonly copy = output<void>();
  readonly fork = output<void>();
  readonly armEdit = output<void>();
  readonly confirmEdit = output<void>();
  readonly cancelEdit = output<void>();
  readonly toggleForks = output<void>();

  preserveSelection(event: MouseEvent): void {
    event.preventDefault();
  }
}
