import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { CodexPlanReviewComponent } from './codex-plan-review.component';

describe('CodexPlanReviewComponent', () => {
  it('renders only the proposed_plan markdown as the review document', async () => {
    await TestBed.configureTestingModule({
      imports: [CodexPlanReviewComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(CodexPlanReviewComponent);
    fixture.componentRef.setInput(
      'content',
      'Preface\n<proposed_plan>\n## Build\n\n- Add parser\n</proposed_plan>\nAfter',
    );
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.cw-plan__document h2')?.textContent).toBe('Build');
    expect(element.querySelector('.cw-plan__document')?.textContent).toContain('Add parser');
    expect(element.querySelector('.cw-plan__document')?.textContent).not.toContain('Preface');
    expect(element.querySelector('.cw-plan__preface')?.textContent).toContain('Preface');
  });

  it('emits formatted feedback for saved comments', async () => {
    await TestBed.configureTestingModule({
      imports: [CodexPlanReviewComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(CodexPlanReviewComponent);
    fixture.componentRef.setInput(
      'content',
      '<proposed_plan>\n## Build\n\n- Add parser before rendering\n</proposed_plan>',
    );
    fixture.detectChanges();

    const feedbackSpy = vi.fn();
    fixture.componentInstance.feedback.subscribe(feedbackSpy);
    fixture.componentInstance.selectedQuote.set('Add parser');
    fixture.componentInstance.beginComment();
    fixture.componentInstance.draftNote.set('Mention malformed XML handling.');
    fixture.componentInstance.saveDraftComment();
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.cw-plan__send') as HTMLButtonElement).click();

    expect(feedbackSpy).toHaveBeenCalledTimes(1);
    const message = feedbackSpy.mock.calls[0][0] as string;
    expect(message).toContain('Stay in plan mode');
    expect(message).toContain('> Add parser');
    expect(message).toContain('Mention malformed XML handling.');
  });
});
