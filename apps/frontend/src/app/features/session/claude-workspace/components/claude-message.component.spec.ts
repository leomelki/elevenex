import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeMessageComponent } from './claude-message.component';

describe('ClaudeMessageComponent', () => {
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
    expect(element.textContent).toContain('Copy');
    expect(element.textContent).toContain('Edit');

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
    expect(element.textContent).not.toContain('Copy');
    expect(element.textContent).not.toContain('Edit message');
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
    buttons.find((button) => button.textContent?.includes('Edit'))?.click();
    expect(armSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();

    fixture.componentRef.setInput('editArmed', true);
    fixture.detectChanges();

    buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-msg__action'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.textContent?.includes('Edit message'))?.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('Rewind to this message?');
  });
});
