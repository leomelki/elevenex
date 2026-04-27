import { inject, Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { BrowserIsolationConfig } from '@/shared/models/browser-isolation.model';

@Injectable({ providedIn: 'root' })
export class BrowserIsolationService {
  private readonly http = inject(HttpClient);

  get(projectId: number) {
    const params = new HttpParams().set('projectId', String(projectId));
    return this.http.get<BrowserIsolationConfig>('/api/browser-isolation', { params });
  }

  save(projectId: number, mode: 'shared' | 'isolated', sharedGlobs: string[]) {
    return this.http.patch<BrowserIsolationConfig>('/api/browser-isolation', {
      projectId,
      mode,
      sharedGlobs,
    });
  }
}
