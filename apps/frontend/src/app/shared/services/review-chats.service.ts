import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  CreateReviewChatRequest,
  CreateReviewChatResponse,
  ReviewAnchor,
  ReviewChat,
  UpdateReviewChatRequest,
} from '@/shared/models/review-chat.model';
import type { CreateSessionForkResponse } from '@/shared/models/session.model';

@Injectable({ providedIn: 'root' })
export class ReviewChatsService {
  private readonly http = inject(HttpClient);

  list(parentSessionId: number, filePath?: string) {
    return this.http.get<ReviewChat[]>(
      `/api/sessions/${parentSessionId}/review-chats`,
      filePath ? { params: { filePath } } : {},
    );
  }

  create(parentSessionId: number, data: CreateReviewChatRequest) {
    return this.http.post<CreateReviewChatResponse>(
      `/api/sessions/${parentSessionId}/review-chats`,
      data,
    );
  }

  sendMessage(parentSessionId: number, chatId: number, message: string) {
    return this.http.post<{ reviewChat: ReviewChat }>(
      `/api/sessions/${parentSessionId}/review-chats/${chatId}/messages`,
      { message },
    );
  }

  addAnchors(parentSessionId: number, chatId: number, anchors: ReviewAnchor[]) {
    return this.http.post<ReviewChat>(
      `/api/sessions/${parentSessionId}/review-chats/${chatId}/anchors`,
      { anchors },
    );
  }

  update(
    parentSessionId: number,
    chatId: number,
    data: UpdateReviewChatRequest,
  ) {
    return this.http.patch<ReviewChat>(
      `/api/sessions/${parentSessionId}/review-chats/${chatId}`,
      data,
    );
  }

  /** Turn a hidden discussion into a standalone session, conversation intact. */
  promote(parentSessionId: number, chatId: number) {
    return this.http.post<CreateSessionForkResponse>(
      `/api/sessions/${parentSessionId}/review-chats/${chatId}/promote`,
      {},
    );
  }

  delete(parentSessionId: number, chatId: number) {
    return this.http.delete<{ id: number; deleted: boolean }>(
      `/api/sessions/${parentSessionId}/review-chats/${chatId}`,
    );
  }
}
