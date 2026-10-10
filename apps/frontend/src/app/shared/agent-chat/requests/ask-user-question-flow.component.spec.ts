import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { AskUserQuestionFlowComponent } from './ask-user-question-flow.component';

describe('Native question answers', () => {
  it('retains comma-containing options in OpenCode multiselect answers', async () => {
    await TestBed.configureTestingModule({
      imports: [AskUserQuestionFlowComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(AskUserQuestionFlowComponent);
    const question = {
      id: 'q',
      question: 'Choose',
      options: [{ label: 'a, b' }, { label: 'c' }],
      multiSelect: true,
    };
    fixture.componentRef.setInput('requestId', 'q');
    fixture.componentRef.setInput('questions', [question]);
    fixture.componentRef.setInput('structuredAnswers', true);
    fixture.detectChanges();
    fixture.componentInstance.selectedAnswers.set({ q: ['a, b', 'c'] });
    fixture.componentInstance.currentQuestionIndex.set(1);
    let response: unknown;
    fixture.componentInstance.submitted.subscribe((value) => {
      response = value;
    });
    fixture.componentInstance.submit();
    expect(response).toEqual({ q: ['a, b', 'c'] });
  });
});
