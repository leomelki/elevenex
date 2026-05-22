import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  ChangeReviewFileWindow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from '@/shared/models/change-review.model';

@Injectable({ providedIn: 'root' })
export class ChangeReviewService {
  private readonly http = inject(HttpClient);

  getSummary(worktreePath: string, scope: ChangeReviewScope, refreshBase = false) {
    return this.http.get<ChangeReviewSummary>('/api/git/change-review/summary', {
      params: {
        worktreePath,
        scope,
        refreshBase: String(refreshBase),
      },
    });
  }

  getFileWindow(
    worktreePath: string,
    scope: ChangeReviewScope,
    path: string,
    options: { offset?: number; limit?: number; context?: number } = {},
  ) {
    return this.http.get<ChangeReviewFileWindow>('/api/git/change-review/window', {
      params: {
        worktreePath,
        scope,
        path,
        offset: String(options.offset ?? 0),
        limit: String(options.limit ?? 600),
        context: String(options.context ?? 8),
      },
    });
  }
}
