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
import { lucideArrowUp, lucideLoader2, lucideSparkles } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { NavigationService } from '@/shared/services/navigation.service';
import { AgentCommandBarService } from './agent-command-bar.service';
import { AgentControlStateService } from './agent-control-state.service';
import { ElevenexAgentService } from './elevenex-agent.service';
import { PendingAgentPromptService } from './pending-agent-prompt.service';

@Component({
  selector: 'app-agent-command-bar',
  standalone: true,
  imports: [NgIcon],
  templateUrl: './agent-command-bar.component.html',
  styleUrl: './agent-command-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowUp,
      lucideLoader2,
      lucideSparkles,
    }),
  ],
})
export class AgentCommandBarComponent {
  private readonly bar = inject(AgentCommandBarService);
  private readonly agentService = inject(ElevenexAgentService);
  private readonly pendingPrompt = inject(PendingAgentPromptService);
  private readonly agentDrawer = inject(AgentControlStateService);
  private readonly navigation = inject(NavigationService);
  private readonly router = inject(Router);

  readonly isOpen = this.bar.isOpen;
  readonly query = signal('');
  readonly submitting = signal(false);
  readonly isMac = this.detectMac();

  @ViewChild('input')
  set inputRef(ref: ElementRef<HTMLTextAreaElement> | undefined) {
    if (ref) {
      // The textarea only exists while the bar is open; focus it the moment it
      // enters the DOM so the user can type immediately.
      queueMicrotask(() => ref.nativeElement.focus());
    }
  }

  constructor() {
    // Reset the draft each time the bar closes so it always opens clean.
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
      // Never hijack the shortcut while the user is still onboarding — the agent
      // has no workspace to run in yet.
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
    this.agentService.createSession(this.deriveName(prompt)).subscribe({
      next: (session) => {
        // Hand the prompt to the workspace that is about to hydrate, surface the
        // agent drawer, then open the session so the answer streams in.
        this.pendingPrompt.set(session.id, prompt);
        this.agentDrawer.open();
        this.navigation.openSession(session.id);
        this.submitting.set(false);
        this.bar.close();
      },
      error: (err) => {
        this.submitting.set(false);
        toast.error(`Could not ask the agent. ${this.messageFrom(err)}`);
      },
    });
  }

  /** A short, human-readable session label taken from the question's first line. */
  private deriveName(prompt: string): string {
    const firstLine = prompt.split('\n', 1)[0].trim();
    return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  }

  private detectMac(): boolean {
    const platform =
      (globalThis.navigator?.platform ?? '') +
      (globalThis.navigator?.userAgent ?? '');
    return /mac|iphone|ipad|ipod/i.test(platform);
  }

  private messageFrom(err: unknown): string {
    const maybe = err as { error?: { message?: string }; message?: string };
    return maybe?.error?.message || maybe?.message || 'Unknown error.';
  }
}
