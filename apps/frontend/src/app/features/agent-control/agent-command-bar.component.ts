import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUp, lucideLoader2, lucideSparkles, lucideLayoutDashboard } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import { AgentCommandBarService } from './agent-command-bar.service';
import { AgentControlStateService } from './agent-control-state.service';

@Component({
  selector: 'app-agent-command-bar',
  standalone: true,
  imports: [NgIcon, DictateTargetDirective, DictationButtonComponent],
  templateUrl: './agent-command-bar.component.html',
  styleUrl: './agent-command-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowUp,
      lucideLoader2,
      lucideSparkles,
      lucideLayoutDashboard,
    }),
  ],
})
export class AgentCommandBarComponent {
  private readonly bar = inject(AgentCommandBarService);
  private readonly agent = inject(AgentControlStateService);
  private readonly router = inject(Router);

  readonly isOpen = this.bar.isOpen;
  readonly contextTab = this.agent.contextTab;
  readonly query = signal('');
  readonly submitting = signal(false);

  @ViewChild('input')
  set inputRef(ref: ElementRef<HTMLTextAreaElement> | undefined) {
    if (ref) {
      // The textarea only exists while the bar is open; focus it the moment it
      // enters the DOM so the user can start typing immediately.
      queueMicrotask(() => ref.nativeElement.focus());
    }
  }

  constructor() {
    // Reset the draft whenever the bar closes so it always opens clean.
    effect(() => {
      if (!this.isOpen()) {
        this.query.set('');
      }
    });
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    const isToggle =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      (event.key === 'k' || event.key === 'K');
    if (isToggle) {
      // Never hijack the shortcut during onboarding — the agent has no workspace
      // to act in yet.
      if (this.router.url.startsWith('/onboarding')) {
        return;
      }
      event.preventDefault();
      this.bar.toggle();
      return;
    }

    if (event.key === 'Escape' && this.isOpen()) {
      event.preventDefault();
      this.close();
    }
  }

  close(): void {
    if (this.submitting()) {
      return;
    }
    this.bar.close();
  }

  onBackdropPointerDown(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  onTextareaKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.submit();
    }
  }

  autoGrow(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }

  async submit(): Promise<void> {
    const prompt = this.query().trim();
    if (!prompt || this.submitting()) {
      return;
    }

    this.submitting.set(true);
    // createMission sends the prompt to the agent, opens the drawer (the agent
    // sidebar) and selects the new mission — exactly the desired flow.
    const sessionId = await this.agent.createMission(prompt);
    this.submitting.set(false);

    if (sessionId === null) {
      toast.error(this.agent.error() ?? 'Could not ask the agent.');
      return;
    }

    this.bar.close();
  }
}
