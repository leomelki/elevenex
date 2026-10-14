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
import { lucideArrowUp, lucideFolderOpen, lucideLoader2, lucideSparkles } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import { AgentControlStateService } from '@/features/agent-control/agent-control-state.service';

/** Repository-first entry point with optional agent assistance for new projects. */
@Component({
  selector: 'app-first-project-prompt',
  standalone: true,
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    DictateTargetDirective,
    DictationButtonComponent,
  ],
  templateUrl: './first-project-prompt.component.html',
  styleUrl: './first-project-prompt.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideArrowUp, lucideFolderOpen, lucideLoader2, lucideSparkles })],
})
export class FirstProjectPromptComponent {
  private readonly agent = inject(AgentControlStateService);

  readonly openRepository = output<void>();
  readonly showAgentHelp = signal(false);

  readonly query = signal('');
  readonly submitting = signal(false);

  @ViewChild('input')
  set inputRef(ref: ElementRef<HTMLTextAreaElement> | undefined) {
    if (ref) {
      // Focus the prompt when the user opens optional agent assistance.
      queueMicrotask(() => ref.nativeElement.focus());
    }
  }

  autoGrow(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  toggleAgentHelp() {
    this.showAgentHelp.update((value) => !value);
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
