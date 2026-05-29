import { Injectable, signal } from '@angular/core';
import { PlanReviewRequest } from './plan-review.model';

export type PlanReviewRailMode = 'comments' | 'ask';

@Injectable({ providedIn: 'root' })
export class PlanAnnotatorStateService {
  private readonly reviewsSignal = signal<Map<number, PlanReviewRequest>>(new Map());
  private readonly visibleSignal = signal<Set<number>>(new Set());
  private readonly railModesSignal = signal<Map<number, PlanReviewRailMode>>(new Map());

  readonly reviews = this.reviewsSignal.asReadonly();
  readonly visible = this.visibleSignal.asReadonly();
  readonly railModes = this.railModesSignal.asReadonly();

  openReview(review: PlanReviewRequest, mode: PlanReviewRailMode = 'comments'): void {
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
    this.setMode(review.sessionId, mode);
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

  getMode(sessionId: number | null | undefined): PlanReviewRailMode {
    return sessionId ? this.railModesSignal().get(sessionId) ?? 'comments' : 'comments';
  }

  setMode(sessionId: number, mode: PlanReviewRailMode): void {
    this.railModesSignal.update((current) => {
      const next = new Map(current);
      next.set(sessionId, mode);
      return next;
    });
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
    this.railModesSignal.update((current) => {
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    this.hide(sessionId);
  }
}
