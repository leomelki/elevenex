import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  inject,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUp, lucideLoader2, lucidePlus, lucideSparkles } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import { AgentControlStateService } from '@/features/agent-control/agent-control-state.service';

/**
 * Centered, Cmd/Ctrl+K-style call-to-action shown in the no-projects empty
 * state. Submitting it asks the Elevenex agent to create the first project
 * (via {@link AgentControlStateService.createMission}, which opens the agent
 * drawer and starts the mission). The manual "Create project" wizard remains
 * available through the {@link createManually} output.
 */
@Component({
  selector: 'app-first-project-prompt',
  standalone: true,
  imports: [
    NgIcon,
    ZardButtonComponent,
    DictateTargetDirective,
    DictationButtonComponent,
  ],
  templateUrl: './first-project-prompt.component.html',
  styleUrl: './first-project-prompt.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideArrowUp, lucideLoader2, lucidePlus, lucideSparkles }),
  ],
})
export class FirstProjectPromptComponent {
  private readonly agent = inject(AgentControlStateService);

  /** Asks the host to open the manual project-creation wizard. */
  readonly createManually = output<void>();

  readonly query = signal('');
  readonly submitting = signal(false);

  @ViewChild('input')
  set inputRef(ref: ElementRef<HTMLTextAreaElement> | undefined) {
    if (ref) {
      // Focus the prompt as soon as it mounts so the user can type their first
      // project straight away — this is the primary call to action.
      queueMicrotask(() => ref.nativeElement.focus());
    }
  }

  autoGrow(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  async submit(): Promise<void> {
    const prompt = this.query().trim();
    if (!prompt || this.submitting()) {
      return;
    }

    this.submitting.set(true);
    // createMission sends the prompt to the agent, opens the agent drawer, and
    // selects the new mission — the agent then drives project creation for us.
    const sessionId = await this.agent.createMission(prompt);
    this.submitting.set(false);

    if (sessionId === null) {
      toast.error(this.agent.error() ?? 'Could not ask the Elevenex agent.');
      return;
    }

    this.query.set('');
  }
}
