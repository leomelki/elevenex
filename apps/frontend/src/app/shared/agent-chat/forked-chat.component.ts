import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Subject, takeUntil } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideMessageSquare,
  lucideSend,
  lucideSquare,
} from '@ng-icons/lucide';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudeRuntimeEvent,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { MarkdownPipe } from '@/features/session/claude-workspace/pipes/markdown.pipe';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import {
  ForkedChatTranscript,
  type ForkedChatLens,
  type ForkedChatVisibleItem,
} from './forked-chat-transcript';

export interface ForkedChatTarget {
  sessionId: number;
  provider: AgentProviderId;
}

/**
 * An embedded chat on a forked session.
 *
 * The caller owns *sending* (each surface wraps prompts in its own guard and
 * posts to its own endpoint); this component owns the socket, the transcript
 * and the composer.
 *
 * It attaches with `borrow()` rather than `connect()` because a fork's parent
 * may already be owned by another surface — see the WebSocket service.
 */
@Component({
  selector: 'app-forked-chat',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MarkdownPipe,
    NgIcon,
    DictateTargetDirective,
    DictationButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideMessageSquare, lucideSend, lucideSquare }),
  ],
  templateUrl: './forked-chat.component.html',
  styleUrl: './forked-chat.component.scss',
})
export class ForkedChatComponent {
  readonly target = input<ForkedChatTarget | null>(null);
  /**
   * Attaching a socket prewarms an agent process, so inactive threads stay
   * detached and only the focused one connects.
   */
  readonly connected = input(true);
  readonly lens = input.required<ForkedChatLens>();
  readonly placeholder = input('Ask a question…');
  readonly emptyState = input('Ask a focused question about this.');
  readonly disabled = input(false);
  /** Set while the caller's own submit request is in flight. */
  readonly sending = input(false);
  /**
   * Text to drop into the composer for the user to edit and send. Each distinct
   * value is applied once, so re-seeding the same text does not re-fill a
   * composer the user has since cleared.
   */
  readonly draftSeed = input<string | null>(null);

  readonly submitPrompt = output<string>();

  private readonly messagesRef = viewChild<ElementRef<HTMLElement>>('messagesRef');
  private readonly composerRef =
    viewChild<ElementRef<HTMLTextAreaElement>>('composerRef');

  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly draft = signal('');
  readonly transcript = signal<ForkedChatTranscript | null>(null);

  private connection: ForkedChatTarget | null = null;
  /**
   * Scoped to the *connection*, not the component: the dock swaps targets many
   * times over one component lifetime, and each swap must drop its subscription.
   */
  private connectionClosed$ = new Subject<void>();
  private stickToBottom = true;
  private appliedSeed: string | null = null;

  constructor() {
    effect(() => {
      const lens = this.lens();
      const target = this.target();
      const connected = this.connected();

      const desired = connected ? target : null;
      if (this.isSameConnection(desired)) return;

      this.detach();
      if (desired) {
        this.attach(desired, lens);
      }
    });

    // Follow the newest message while streaming, unless the user has scrolled
    // up to read something.
    effect(() => {
      const transcript = this.transcript();
      transcript?.items();
      transcript?.runPhase();
      if (!this.stickToBottom) return;
      const element = this.messagesRef()?.nativeElement;
      if (!element) return;
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
      });
    });

    effect(() => {
      this.draft();
      requestAnimationFrame(() => this.autoGrow());
    });

    effect(() => {
      const seed = this.draftSeed();
      if (!seed || seed === this.appliedSeed) return;
      this.appliedSeed = seed;
      this.draft.update((current) =>
        current.trim() ? `${current.trimEnd()}\n\n${seed}` : seed,
      );
      requestAnimationFrame(() => this.composerRef()?.nativeElement.focus());
    });

    this.destroyRef.onDestroy(() => this.detach());
  }

  get items(): ForkedChatVisibleItem[] {
    return this.transcript()?.items() ?? [];
  }

  itemContent(item: ForkedChatVisibleItem): string {
    return this.transcript()?.displayContent(item) ?? '';
  }

  onMessagesScroll(): void {
    const element = this.messagesRef()?.nativeElement;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    this.stickToBottom = distanceFromBottom < 48;
  }

  onComposeKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.disabled() || this.sending()) return;

    this.stickToBottom = true;
    this.transcript()?.addOptimisticPrompt(text);
    this.draft.set('');
    this.submitPrompt.emit(text);
  }

  /** Roll back the optimistic bubble when the caller's submit failed. */
  revertPrompt(text: string): void {
    const transcript = this.transcript();
    if (!transcript) return;
    const match = transcript
      .optimistic()
      .find((item) => item.content === text);
    if (match) transcript.removeOptimistic(match.id);
    this.draft.set(text);
  }

  interrupt(): void {
    const target = this.connection;
    if (!target) return;
    this.ws.send(target.sessionId, { type: 'interrupt' }, target.provider);
  }

  /** Pull the persisted history after a turn ends. */
  async refreshHistory(): Promise<void> {
    const target = this.connection;
    const transcript = this.transcript();
    if (!target || !transcript) return;
    const history = (await firstValueFrom(
      this.agentApi.getHistory(target.sessionId, target.provider),
    )) as ClaudeTranscriptItem[];
    if (this.connection?.sessionId !== target.sessionId) return;
    transcript.applyHistoryRefresh(history);
  }

  autoGrow(): void {
    const element = this.composerRef()?.nativeElement;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  }

  private isSameConnection(target: ForkedChatTarget | null): boolean {
    if (!target || !this.connection) return target === this.connection;
    return (
      this.connection.sessionId === target.sessionId &&
      this.connection.provider === target.provider
    );
  }

  private attach(target: ForkedChatTarget, lens: ForkedChatLens): void {
    const transcript = new ForkedChatTranscript(lens);
    this.transcript.set(transcript);
    this.connection = target;
    this.connectionClosed$ = new Subject<void>();
    this.stickToBottom = true;

    this.ws
      .borrow(target.sessionId, target.provider)
      .pipe(takeUntil(this.connectionClosed$))
      .subscribe((event) => {
        const runtimeEvent = event as ClaudeRuntimeEvent;
        transcript.apply(runtimeEvent);
        if (runtimeEvent.type === 'complete') {
          void this.refreshHistory();
        }
      });

    this.ws.send(target.sessionId, { type: 'hydrate' }, target.provider);
  }

  private detach(): void {
    this.connectionClosed$.next();
    this.connectionClosed$.complete();
    if (this.connection) {
      this.ws.releaseBorrow(this.connection.sessionId, this.connection.provider);
    }
    this.connection = null;
    this.transcript.set(null);
  }
}
