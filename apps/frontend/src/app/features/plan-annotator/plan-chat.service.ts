import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  EnsurePlanChatRequest,
  EnsurePlanChatResponse,
  PlanChatFork,
  SubmitPlanChatQuestionRequest,
  SubmitPlanChatQuestionResponse,
} from '@/shared/models/session.model';

@Injectable({ providedIn: 'root' })
export class PlanChatService {
  private readonly http = inject(HttpClient);

  getByReview(parentSessionId: number, reviewId: string) {
    return this.http.get<PlanChatFork[]>(`/api/sessions/${parentSessionId}/plan-chats`, {
      params: { reviewId },
    });
  }

  ensure(parentSessionId: number, data: EnsurePlanChatRequest) {
    return this.http.post<EnsurePlanChatResponse>(
      `/api/sessions/${parentSessionId}/plan-chats`,
      data,
    );
  }

  submitQuestion(
    parentSessionId: number,
    planChatId: number,
    data: SubmitPlanChatQuestionRequest,
  ) {
    return this.http.post<SubmitPlanChatQuestionResponse>(
      `/api/sessions/${parentSessionId}/plan-chats/${planChatId}/questions`,
      data,
    );
  }

  delete(parentSessionId: number, planChatId: number) {
    return this.http.delete<{ id: number; deleted: boolean }>(
      `/api/sessions/${parentSessionId}/plan-chats/${planChatId}`,
    );
  }
}
