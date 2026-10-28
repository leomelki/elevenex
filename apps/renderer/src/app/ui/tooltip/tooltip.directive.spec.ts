import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipDirective } from './tooltip.directive';

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
});
