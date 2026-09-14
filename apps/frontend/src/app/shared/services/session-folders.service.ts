import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SessionFolder } from '../models/session.model';

@Injectable({ providedIn: 'root' })
export class SessionFoldersService {
  private readonly http = inject(HttpClient);

  create(data: { repoId: number; workspaceId: number; name: string }) {
    return this.http.post<SessionFolder>('/api/session-folders', data);
  }

  rename(id: number, name: string) {
    return this.http.patch<SessionFolder>(`/api/session-folders/${id}`, { name });
  }

  archive(id: number) {
    return this.http.post<SessionFolder>(`/api/session-folders/${id}/archive`, {});
  }

  unarchive(id: number) {
    return this.http.post<SessionFolder>(`/api/session-folders/${id}/unarchive`, {});
  }

  delete(id: number) {
    return this.http.delete<SessionFolder & { deletedSessionIds: number[] }>(
      `/api/session-folders/${id}`,
    );
  }
}
