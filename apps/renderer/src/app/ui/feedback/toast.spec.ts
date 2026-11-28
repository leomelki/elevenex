import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastComponent } from './toast.component';

afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

it.each([undefined, 0, -1, NaN, Infinity])('automatically dismisses after five seconds for duration %s', (duration) => {
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(ToastComponent);
  fixture.componentRef.setInput('title', 'Archived session');
  if (duration !== undefined) fixture.componentRef.setInput('duration', duration);
  const dismissed = vi.fn();
  fixture.componentInstance.dismissed.subscribe(dismissed);
  fixture.detectChanges();
  vi.advanceTimersByTime(4999);
  expect(dismissed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(dismissed).toHaveBeenCalledOnce();
});

it('honors a custom timeout and pauses until both hover and keyboard focus leave', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const fixture = TestBed.createComponent(ToastComponent);
  fixture.componentRef.setInput('title', 'Archived session');
  fixture.componentRef.setInput('duration', 2000);
  const dismissed = vi.fn();
  fixture.componentInstance.dismissed.subscribe(dismissed);
  fixture.detectChanges();
  const toast: HTMLElement = fixture.nativeElement;
  vi.advanceTimersByTime(1000);
  toast.dispatchEvent(new MouseEvent('mouseenter'));
  toast.dispatchEvent(new FocusEvent('focusin'));
  vi.advanceTimersByTime(5000);
  toast.dispatchEvent(new MouseEvent('mouseleave'));
  vi.advanceTimersByTime(5000);
  expect(dismissed).not.toHaveBeenCalled();
  toast.dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }));
  vi.advanceTimersByTime(999);
  expect(dismissed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(dismissed).toHaveBeenCalledOnce();
});

it('clears its timeout when destroyed', () => {
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(ToastComponent);
  fixture.componentRef.setInput('title', 'Archived session');
  fixture.detectChanges();
  const dismissed = vi.spyOn(fixture.componentInstance.dismissed, 'emit');
  fixture.destroy();
  vi.advanceTimersByTime(5000);
  expect(dismissed).not.toHaveBeenCalled();
});

it('retains asynchronous actions until confirmed by their owner and disables duplicates while pending', () => {
  const fixture = TestBed.createComponent(ToastComponent);
  fixture.componentRef.setInput('title', 'Archived session');
  fixture.componentRef.setInput('action', 'Undo');
  fixture.componentRef.setInput('dismissOnAction', false);
  const action = vi.fn(), dismissed = vi.fn();
  fixture.componentInstance.actionSelected.subscribe(action);
  fixture.componentInstance.dismissed.subscribe(dismissed);
  fixture.detectChanges();
  const button = fixture.nativeElement.querySelector('button[exButton]') as HTMLButtonElement;
  button.click(); expect(action).toHaveBeenCalledOnce(); expect(dismissed).not.toHaveBeenCalled();
  fixture.componentRef.setInput('busy', true); fixture.detectChanges();
  expect(button.disabled).toBe(true); button.click(); expect(action).toHaveBeenCalledOnce();
  fixture.componentRef.setInput('busy', false); fixture.detectChanges(); button.click();
  expect(action).toHaveBeenCalledTimes(2);
  fixture.nativeElement.querySelector('[aria-label="Dismiss notification"]').click();
  expect(dismissed).toHaveBeenCalledOnce();
});
