import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideEllipsis,
  lucideExternalLink,
  lucideLock,
  lucideLockOpen,
  lucideMessageSquare,
  lucidePlus,
  lucideTrash2,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import {
  ForkedChatComponent,
  type ForkedChatLens,
  type ForkedChatTarget,
} from '@/shared/agent-chat';
import { ZardDialogService } from '@/shared/components/dialog';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { anchorLabel } from './review-anchors';
import {
  ReviewWorkspaceStateService,
  SESSION_TAB_ID,
} from './review-workspace-state.service';

const REVIEW_QUESTION_RE =
  /<elevenex_review_question>\s*([\s\S]*?)\s*<\/elevenex_review_question>/i;

/** Strips the backend's review guard so the user sees what they typed. */
const REVIEW_LENS: ForkedChatLens = {
  sanitizeUserContent: (content) => {
    const text = content ?? '';
    return (REVIEW_QUESTION_RE.exec(text)?.[1] ?? text).trim();
  },
  isOwnPrompt: (item) => REVIEW_QUESTION_RE.test(item.content ?? ''),
};

/** The parent session's own chat needs no unwrapping and hides nothing. */
const SESSION_LENS: ForkedChatLens = {
  sanitizeUserContent: (content) => (content ?? '').trim(),
  isOwnPrompt: () => true,
};

@Component({
  selector: 'app-review-thread-dock',
  standalone: true,
  imports: [CommonModule, NgIcon, ForkedChatComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideEllipsis,
      lucideExternalLink,
      lucideLock,
      lucideLockOpen,
      lucideMessageSquare,
      lucidePlus,
      lucideTrash2,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './review-thread-dock.component.html',
  styleUrl: './review-thread-dock.component.scss',
})
export class ReviewThreadDockComponent {
  readonly sessionId = input.required<number>();
  readonly provider = input.required<AgentProviderId>();
  /** False when the provider cannot fork, so thread creation is unavailable. */
  readonly canFork = input(true);
  /** Anchors whose file has changed since the discussion started. */
  readonly staleThreadIds = input<ReadonlySet<number>>(new Set<number>());
  /** Text to drop into the active composer, e.g. a diff selection to ask about. */
  readonly draftSeed = input<string | null>(null);

  readonly promoted = output<unknown>();

  readonly state = inject(ReviewWorkspaceStateService);
  private readonly dialog = inject(ZardDialogService);
  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly chat = viewChild(ForkedChatComponent);

  readonly menuOpenFor = signal<number | null>(null);
  readonly sessionTabId = SESSION_TAB_ID;

  readonly isSessionTab = computed(
    () => this.state.activeThreadId() === SESSION_TAB_ID,
  );

  /**
   * Only the focused thread holds a socket: attaching one prewarms an agent
   * process, so keeping every tab connected would thrash the runtime's idle
   * budget and cold-start the main session.
   */
  readonly activeTarget = computed<ForkedChatTarget | null>(() => {
    if (this.isSessionTab()) {
      return { sessionId: this.sessionId(), provider: this.provider() };
    }
    const chat = this.state.activeChat();
    return chat ? { sessionId: chat.childSessionId, provider: chat.provider } : null;
  });

  readonly activeLens = computed<ForkedChatLens>(() =>
    this.isSessionTab() ? SESSION_LENS : REVIEW_LENS,
  );

  readonly activeAnchorLabels = computed(() => {
    const chat = this.state.activeChat();
    return chat ? chat.anchors.map((anchor) => anchorLabel(anchor)) : [];
  });

  readonly sending = computed(() => {
    const chat = this.state.activeChat();
    return chat !== null && this.state.busyThreadId() === chat.id;
  });

  selectTab(id: number): void {
    this.menuOpenFor.set(null);
    if (id === SESSION_TAB_ID) {
      this.state.activeThreadId.set(SESSION_TAB_ID);
      return;
    }
    this.state.focusThread(id);
  }

  isStale(chat: ReviewChat): boolean {
    return this.staleThreadIds().has(chat.id);
  }

  isUnread(chat: ReviewChat): boolean {
    return this.state.unreadThreadIds().has(chat.id);
  }

  toggleMenu(chatId: number, event: MouseEvent): void {
    event.stopPropagation();
    this.menuOpenFor.update((open) => (open === chatId ? null : chatId));
  }

  closeMenu(): void {
    this.menuOpenFor.set(null);
  }

  async onSubmit(text: string): Promise<void> {
    if (this.isSessionTab()) {
      // Talking "in the session" really does go to the main session: the dock
      // is attached to its socket, and the gateway fans the turn out to every
      // client, so the Claude workspace stays in sync.
      this.ws.send(
        this.sessionId(),
        { type: 'submit_prompt', prompt: text, titlePrompt: text },
        this.provider(),
      );
      return;
    }

    const chat = this.state.activeChat();
    if (!chat) return;
    const ok = await this.state.sendMessage(chat.id, text);
    if (!ok) this.chat()?.revertPrompt(text);
  }

  async unlockEdits(chat: ReviewChat): Promise<void> {
    this.closeMenu();
    const confirmed = await this.confirm({
      title: 'Allow this discussion to edit files?',
      body:
        'This discussion shares a worktree with your session. If both write to the ' +
        'same files, their changes can conflict.',
      okText: 'Allow edits',
    });
    if (!confirmed) return;
    await this.state.setMode(chat.id, 'write');
  }

  async lockEdits(chat: ReviewChat): Promise<void> {
    this.closeMenu();
    await this.state.setMode(chat.id, 'readonly');
  }

  async promote(chat: ReviewChat): Promise<void> {
    this.closeMenu();
    const response = await this.state.promote(chat.id);
    if (response) {
      toast.success('Opened as a session', {
        description: 'The discussion continues in its own tab.',
      });
      this.promoted.emit(response);
    }
  }

  async resolve(chat: ReviewChat): Promise<void> {
    this.closeMenu();
    await this.state.resolve(chat.id);
  }

  async remove(chat: ReviewChat): Promise<void> {
    this.closeMenu();
    const confirmed = await this.confirm({
      title: 'Delete this discussion?',
      body: 'The conversation will be lost. This cannot be undone.',
      okText: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    await this.state.remove(chat.id);
  }

  private confirm(options: {
    title: string;
    body: string;
    okText: string;
    destructive?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const ref = this.dialog.create({
        zTitle: options.title,
        zDescription: options.body,
        zOkText: options.okText,
        zCancelText: 'Cancel',
        zOkDestructive: options.destructive,
        zOnOk: () => settle(true),
        zOnCancel: () => settle(false),
      });
      // Escape and mask dismissal fire neither callback.
      ref.afterClosed().subscribe(() => settle(false));
    });
  }
}
