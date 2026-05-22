import { Injectable, signal } from '@angular/core';
import { PlanReviewRequest } from './plan-review.model';

@Injectable({ providedIn: 'root' })
export class PlanAnnotatorStateService {
  private readonly reviewsSignal = signal<Map<number, PlanReviewRequest>>(new Map());
  private readonly visibleSignal = signal<Set<number>>(new Set());

  readonly reviews = this.reviewsSignal.asReadonly();
  readonly visible = this.visibleSignal.asReadonly();

  openReview(review: PlanReviewRequest): void {
    this.reviewsSignal.update((current) => {
      const next = new Map(current);
      next.set(review.sessionId, review);
      return next;
    });
    this.visibleSignal.update((current) => {
      const next = new Set(current);
      next.add(review.sessionId);
      return next;
    });
  }

  setReview(review: PlanReviewRequest): void {
    this.reviewsSignal.update((current) => {
      const next = new Map(current);
      next.set(review.sessionId, review);
      return next;
    });
  }

  getReview(sessionId: number | null | undefined): PlanReviewRequest | null {
    return sessionId ? this.reviewsSignal().get(sessionId) ?? null : null;
  }

  hasReview(sessionId: number | null | undefined): boolean {
    return !!sessionId && this.reviewsSignal().has(sessionId);
  }

  isVisible(sessionId: number | null | undefined): boolean {
    return !!sessionId && this.visibleSignal().has(sessionId);
  }

  show(sessionId: number): void {
    if (!this.reviewsSignal().has(sessionId)) return;
    this.visibleSignal.update((current) => {
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
  }

  hide(sessionId: number): void {
    this.visibleSignal.update((current) => {
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }

  close(sessionId: number): void {
    this.hide(sessionId);
  }

  clear(sessionId: number): void {
    this.reviewsSignal.update((current) => {
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    this.hide(sessionId);
  }
}
