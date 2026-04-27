import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface Section {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  content: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class ScratchpadService {
  private http = inject(HttpClient);

  private baseUrl(projectId: number): string {
    return `/api/projects/${projectId}/scratchpad`;
  }

  getSections(projectId: number): Observable<Section[]> {
    return this.http.get<Section[]>(this.baseUrl(projectId));
  }

  createSection(projectId: number, name: string, description?: string): Observable<Section> {
    return this.http.post<Section>(this.baseUrl(projectId), { name, description });
  }

  updateSection(sectionId: number, data: Partial<Section>): Observable<Section> {
    return this.http.patch<Section>(`/api/scratchpad/${sectionId}`, data);
  }

  updateOrders(projectId: number, orders: { id: number; sortOrder: number }[]): Observable<void> {
    return this.http.put<void>(`${this.baseUrl(projectId)}/orders`, { orders });
  }

  deleteSection(sectionId: number): Observable<void> {
    return this.http.delete<void>(`/api/scratchpad/${sectionId}`);
  }
}