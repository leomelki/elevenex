import { inject, Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';

export interface Todo {
  id: number;
  projectId: number;
  text: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable({ providedIn: 'root' })
export class TodosService {
  private http = inject(HttpClient);

  private readonly pendingCounts = signal<Map<number, number>>(new Map());

  getPendingCount(projectId: number): number {
    return this.pendingCounts().get(projectId) ?? 0;
  }

  setPendingCount(projectId: number, count: number): void {
    const next = new Map(this.pendingCounts());
    next.set(projectId, count);
    this.pendingCounts.set(next);
  }

  /** Read the signal directly for reactive bindings */
  readonly pendingCountsSignal = this.pendingCounts.asReadonly();

  private baseUrl(projectId: number): string {
    return `/api/projects/${projectId}/todos`;
  }

  getTodos(projectId: number): Observable<Todo[]> {
    return this.http.get<Todo[]>(this.baseUrl(projectId)).pipe(
      tap(todos => this.setPendingCount(projectId, todos.filter(t => !t.completed).length)),
    );
  }

  createTodo(projectId: number, text: string): Observable<Todo> {
    return this.http.post<Todo>(this.baseUrl(projectId), { text });
  }

  updateTodo(todoId: number, data: Partial<Todo>): Observable<Todo> {
    return this.http.patch<Todo>(`/api/todos/${todoId}`, data);
  }

  updateOrders(projectId: number, orders: { id: number; sortOrder: number }[]): Observable<void> {
    return this.http.put<void>(`${this.baseUrl(projectId)}/orders`, { orders });
  }

  deleteTodo(todoId: number): Observable<void> {
    return this.http.delete<void>(`/api/todos/${todoId}`);
  }

  clearCompleted(projectId: number): Observable<{ count: number }> {
    return this.http.delete<{ count: number }>(`${this.baseUrl(projectId)}/completed`);
  }
}