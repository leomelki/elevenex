import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeMessageComponent } from './claude-message.component';

describe('ClaudeMessageComponent', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  it('renders copy and edit actions only for user messages', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Ship it',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showActions', true);
    fixture.detectChanges();

    let element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Edit message"]')).not.toBeNull();

    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: 'Done',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
      sourceMessageId: 'source-assistant-1',
    });
    fixture.componentRef.setInput('showActions', false);
    fixture.detectChanges();

    element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[aria-label="Copy message"]')).toBeNull();
    expect(element.querySelector('[aria-label="Edit message"]')).toBeNull();
  });

  it('emits arm/edit confirmation events in sequence', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Rework this prompt',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showActions', true);

    const armSpy = vi.fn();
    const confirmSpy = vi.fn();
    fixture.componentInstance.armEdit.subscribe(armSpy);
    fixture.componentInstance.confirmEdit.subscribe(confirmSpy);

    fixture.detectChanges();
    let buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-msg__action'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.getAttribute('aria-label') === 'Edit message')?.click();
    expect(armSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();

    fixture.componentRef.setInput('editArmed', true);
    fixture.detectChanges();

    buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-msg__action'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.getAttribute('aria-label') === 'Confirm edit')?.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('Rewind to this message?');
  });

  it('emits selected text when copying part of a message', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Copy only this phrase',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showActions', true);

    const copySpy = vi.fn();
    fixture.componentInstance.copy.subscribe(copySpy);
    fixture.detectChanges();

    const bubble = fixture.nativeElement.querySelector('.cw-msg__bubble') as HTMLElement;
    const textNode = bubble.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.setEnd(textNode, 14);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    const copyButton = fixture.nativeElement.querySelector(
      '.cw-msg__action[aria-label="Copy message"]',
    ) as HTMLButtonElement;
    copyButton.click();

    expect(copySpy).toHaveBeenCalledWith('only this');
  });

  it('renders markdown while assistant text is streaming', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: '**Bold** and `code`',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
      sourceMessageId: 'source-assistant-1',
    });
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.cw-md--streaming strong')?.textContent).toBe('Bold');
    expect(element.querySelector('.cw-md--streaming code')?.textContent).toBe('code');
    expect(element.textContent).not.toContain('**Bold**');
    expect(element.querySelector('.cw-caret')).not.toBeNull();
  });
});
