import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeComposerComponent } from './claude-composer.component';

describe('ClaudeComposerComponent', () => {
  it('disables send while a permission request is pending', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', true);
    fixture.componentRef.setInput('sendDisabledReason', 'Approve or deny the pending request to resume the conversation.');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const sendButton = element.querySelector('.cw-comp__btn--send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(element.textContent).toContain('Approve or deny the pending request');
  });

  it('blocks Enter submit while a permission request is pending', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', true);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    fixture.componentInstance.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resumes normal send once the permission request is cleared', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', false);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    fixture.componentInstance.submit();
    expect(sendSpy).toHaveBeenCalledWith('Continue');
  });
});
