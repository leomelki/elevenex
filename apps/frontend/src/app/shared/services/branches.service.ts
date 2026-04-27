import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BranchInfo } from '../models/branch.model';

@Injectable({ providedIn: 'root' })
export class BranchesService {
  private http = inject(HttpClient);

  getByRepo(repoId: number) {
    return this.http.get<BranchInfo[]>(`/api/repos/${repoId}/branches`);
  }

  searchBranches(repoId: number, query: string, allowEmpty?: boolean) {
    const params: Record<string, string> = { q: query };
    if (allowEmpty) params['allowEmpty'] = 'true';
    return this.http.get<BranchInfo[]>(
      `/api/repos/${repoId}/branches/search`,
      { params },
    );
  }

  searchRemoteBranches(repoId: number, query: string) {
    return this.http.get<BranchInfo[]>(
      `/api/repos/${repoId}/branches/search-remote`,
      { params: { q: query } },
    );
  }

  createBranch(repoId: number, name: string, startPoint?: string) {
    return this.http.post<BranchInfo>(`/api/repos/${repoId}/branches`, {
      name,
      startPoint,
    });
  }
}