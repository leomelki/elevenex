import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeComposerComponent } from './claude-composer.component';

describe('ClaudeComposerComponent', () => {
  it('shrinks the textarea when the value is cleared programmatically', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Line 1\nLine 2\nLine 3');
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('.cw-comp__ta') as HTMLTextAreaElement;
    let scrollHeight = 120;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    fixture.componentInstance.onInput({ target: textarea } as Event);
    expect(textarea.style.height).toBe('120px');

    scrollHeight = 0;
    fixture.componentRef.setInput('value', '');
    fixture.detectChanges();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(textarea.value).toBe('');
    expect(textarea.style.height).toBe('0px');
  });

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
