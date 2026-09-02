import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  ReviewAnchor,
  ReviewChat,
  ReviewChatMode,
} from '@/shared/models/review-chat.model';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { buildAnchorRowIndex } from './review-anchors';

/** The dock always shows the parent session first, then one tab per thread. */
export const SESSION_TAB_ID = 0;

/**
 * Warn before the machine feels it. Each thread is a forked session, and each
 * forked session eventually owns an agent process.
 */
export const CROWDED_THREAD_COUNT = 4;

@Injectable({ providedIn: 'root' })
export class ReviewWorkspaceStateService {
  private readonly api = inject(ReviewChatsService);

  readonly chats = signal<ReviewChat[]>([]);
  readonly activeThreadId = signal<number>(SESSION_TAB_ID);
  readonly loading = signal(false);
  readonly busyThreadId = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  /** Threads with an answer the user has not looked at since. */
  readonly unreadThreadIds = signal<ReadonlySet<number>>(new Set());

  private parentSessionId: number | null = null;

  readonly openChats = computed(() =>
    this.chats().filter((chat) => chat.status !== 'resolved'),
  );

  readonly activeChat = computed(
    () => this.chats().find((chat) => chat.id === this.activeThreadId()) ?? null,
  );

  readonly anchorRowIndex = computed(() => buildAnchorRowIndex(this.openChats()));

  readonly crowded = computed(
    () => this.openChats().length >= CROWDED_THREAD_COUNT,
  );

  async load(parentSessionId: number): Promise<void> {
    this.parentSessionId = parentSessionId;
    this.loading.set(true);
    this.error.set(null);
    try {
      const chats = await firstValueFrom(this.api.list(parentSessionId));
      if (this.parentSessionId !== parentSessionId) return;
      this.chats.set(chats);
    } catch (error) {
      this.error.set(this.message(error, 'Could not load review discussions.'));
    } finally {
      if (this.parentSessionId === parentSessionId) this.loading.set(false);
    }
  }

  async createThread(
    anchors: ReviewAnchor[],
    options: { scope?: string; turnKey?: string } = {},
  ): Promise<ReviewChat | null> {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return null;

    this.error.set(null);
    try {
      const response = await firstValueFrom(
        this.api.create(parentSessionId, { anchors, ...options }),
      );
      this.chats.update((chats) => [...chats, response.reviewChat]);
      this.activeThreadId.set(response.reviewChat.id);
      return response.reviewChat;
    } catch (error) {
      this.error.set(this.message(error, 'Could not start the discussion.'));
      return null;
    }
  }

  async addAnchors(chatId: number, anchors: ReviewAnchor[]): Promise<void> {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return;
    try {
      const updated = await firstValueFrom(
        this.api.addAnchors(parentSessionId, chatId, anchors),
      );
      this.replace(updated);
      this.activeThreadId.set(chatId);
    } catch (error) {
      this.error.set(this.message(error, 'Could not add to the discussion.'));
    }
  }

  async sendMessage(chatId: number, message: string): Promise<boolean> {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return false;

    this.busyThreadId.set(chatId);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.sendMessage(parentSessionId, chatId, message));
      return true;
    } catch (error) {
      this.error.set(this.message(error, 'Could not send the message.'));
      return false;
    } finally {
      this.busyThreadId.set(null);
    }
  }

  async setMode(chatId: number, mode: ReviewChatMode): Promise<void> {
    await this.patch(chatId, { mode }, 'Could not change the discussion mode.');
  }

  async rename(chatId: number, title: string): Promise<void> {
    await this.patch(chatId, { title }, 'Could not rename the discussion.');
  }

  async resolve(chatId: number): Promise<void> {
    await this.patch(chatId, { status: 'resolved' }, 'Could not resolve the discussion.');
    if (this.activeThreadId() === chatId) this.activeThreadId.set(SESSION_TAB_ID);
  }

  async markRead(chatId: number): Promise<void> {
    this.unreadThreadIds.update((ids) => {
      if (!ids.has(chatId)) return ids;
      const next = new Set(ids);
      next.delete(chatId);
      return next;
    });
    await this.patch(chatId, { markRead: true }, 'Could not update the discussion.');
  }

  markUnread(chatId: number): void {
    if (this.activeThreadId() === chatId) return;
    this.unreadThreadIds.update((ids) => new Set(ids).add(chatId));
  }

  async promote(chatId: number) {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return null;
    try {
      const response = await firstValueFrom(
        this.api.promote(parentSessionId, chatId),
      );
      this.chats.update((chats) =>
        chats.map((chat) =>
          chat.id === chatId ? { ...chat, status: 'promoted', mode: 'write' } : chat,
        ),
      );
      return response;
    } catch (error) {
      this.error.set(this.message(error, 'Could not open the discussion as a session.'));
      return null;
    }
  }

  async remove(chatId: number): Promise<void> {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return;
    try {
      await firstValueFrom(this.api.delete(parentSessionId, chatId));
      this.chats.update((chats) => chats.filter((chat) => chat.id !== chatId));
      if (this.activeThreadId() === chatId) this.activeThreadId.set(SESSION_TAB_ID);
    } catch (error) {
      this.error.set(this.message(error, 'Could not delete the discussion.'));
    }
  }

  focusThread(chatId: number): void {
    this.activeThreadId.set(chatId);
    void this.markRead(chatId);
  }

  reset(): void {
    this.parentSessionId = null;
    this.chats.set([]);
    this.activeThreadId.set(SESSION_TAB_ID);
    this.unreadThreadIds.set(new Set());
    this.error.set(null);
    this.loading.set(false);
  }

  private async patch(
    chatId: number,
    data: Parameters<ReviewChatsService['update']>[2],
    fallback: string,
  ): Promise<void> {
    const parentSessionId = this.parentSessionId;
    if (parentSessionId === null) return;
    try {
      const updated = await firstValueFrom(
        this.api.update(parentSessionId, chatId, data),
      );
      this.replace(updated);
    } catch (error) {
      this.error.set(this.message(error, fallback));
    }
  }

  private replace(updated: ReviewChat): void {
    this.chats.update((chats) =>
      chats.map((chat) =>
        chat.id === updated.id ? { ...chat, ...updated } : chat,
      ),
    );
  }

  private message(error: unknown, fallback: string): string {
    return (
      (error as { error?: { message?: string } })?.error?.message ||
      (error instanceof Error ? error.message : null) ||
      fallback
    );
  }
}
