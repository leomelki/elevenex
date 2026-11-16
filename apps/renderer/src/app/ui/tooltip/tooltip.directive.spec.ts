import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipDirective, TooltipTiming } from './tooltip.directive';

@Component({
  imports: [TooltipDirective],
  template: '<button exTooltip="First title">First</button><button exTooltip="Second title">Second</button>',
})
class TooltipHostComponent {}

afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

describe('tooltip ownership', () => {
  it('replaces a focused tooltip on hover and releases the overlay on Escape or destruction', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [TooltipHostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(TooltipHostComponent);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    const labels = () => [...document.querySelectorAll('ex-tooltip')].map(element => element.textContent?.trim());
    buttons[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.runOnlyPendingTimers(); fixture.detectChanges();
    expect(labels()).toEqual(['First title']);
    expect((document.querySelector('ex-tooltip')?.closest('.cdk-overlay-pane') as HTMLElement).style.pointerEvents).toBe('none');
    buttons[1]!.dispatchEvent(new MouseEvent('mouseenter'));
    vi.runOnlyPendingTimers(); fixture.detectChanges();
    expect(labels()).toEqual(['Second title']);
    buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(labels()).toEqual([]);
    buttons[0]!.dispatchEvent(new MouseEvent('mouseenter'));
    vi.runOnlyPendingTimers(); fixture.detectChanges();
    expect(labels()).toEqual(['First title']);
    fixture.destroy();
    expect(labels()).toEqual([]);
  });
  it('stops following and clears the accessible description when scrolling detaches the tooltip', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [TooltipHostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(TooltipHostComponent);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    const readAnchor = vi.spyOn(button, 'getBoundingClientRect');
    button.focus();
    vi.advanceTimersByTime(40);
    fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(true);
    document.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    const reads = readAnchor.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(readAnchor.mock.calls).toHaveLength(reads);
    // A new focus can create and clean up another tooltip after detachment.
    button.blur();
    button.focus();
    vi.advanceTimersByTime(40);
    fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
    fixture.destroy();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    const destroyedReads = readAnchor.mock.calls.length;
    vi.advanceTimersByTime(100);
    expect(readAnchor.mock.calls).toHaveLength(destroyedReads);
    readAnchor.mockRestore();
  });
  it('closes an open tooltip on dragstart and blocks hover/focus tooltips until drop or cancellation', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [TooltipHostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(TooltipHostComponent);
    fixture.detectChanges();
    const [source, target] = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    source!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(40); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
    expect(source!.hasAttribute('aria-describedby')).toBe(true);
    const pane = document.querySelector<HTMLElement>('.cdk-overlay-pane');
    expect(pane?.style.pointerEvents).toBe('none');

    source!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    expect(document.querySelector('ex-tooltip')).toBeNull();
    expect(source!.hasAttribute('aria-describedby')).toBe(false);
    target!.dispatchEvent(new MouseEvent('mouseenter'));
    target!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(800); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).toBeNull();

    document.dispatchEvent(new Event('drop'));
    expect(document.querySelector('ex-tooltip')).toBeNull();
    target!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(40); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')?.textContent).toContain('Second title');
    source!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    source!.dispatchEvent(new Event('dragend', { bubbles: true }));
    target!.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(40); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
  });

  it('cancels delayed tooltips and recovers when a dragstart is prevented or the window loses focus', async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({ imports: [TooltipHostComponent] }).compileComponents();
    const fixture = TestBed.createComponent(TooltipHostComponent);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('mouseenter'));
    button.dispatchEvent(new Event('dragstart', { bubbles: true }));
    document.dispatchEvent(new Event('drop'));
    vi.advanceTimersByTime(800); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).toBeNull();

    const cancelled = new Event('dragstart', { bubbles: true, cancelable: true });
    button.addEventListener('dragstart', event => event.preventDefault(), { once: true });
    button.dispatchEvent(cancelled);
    await Promise.resolve();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(40); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
    document.dispatchEvent(new Event('dragover'));
    expect(document.querySelector('ex-tooltip')).toBeNull();
    window.dispatchEvent(new Event('blur'));
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(40); fixture.detectChanges();
    expect(document.querySelector('ex-tooltip')).not.toBeNull();
  });

  it('removes shared drag listeners when the renderer injector is destroyed', () => {
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    TestBed.inject(TooltipTiming);
    TestBed.resetTestingModule();
    for (const type of ['dragstart','dragover','dragend','drop','pointerdown'])
      expect(removeDocument).toHaveBeenCalledWith(type, expect.any(Function), true);
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
    removeDocument.mockRestore(); removeWindow.mockRestore();
  });

});
