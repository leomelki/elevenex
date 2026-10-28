import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { ToastComponent } from './toast.component';

afterEach(() => TestBed.resetTestingModule());
it('retains asynchronous actions until confirmed by their owner and disables duplicates while pending', () => {
  const fixture = TestBed.createComponent(ToastComponent);
  fixture.componentRef.setInput('title', 'Archived session');
  fixture.componentRef.setInput('action', 'Undo');
  fixture.componentRef.setInput('duration', 0);
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
