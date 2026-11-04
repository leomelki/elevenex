import { TestBed } from '@angular/core/testing';
import { ViewTabsComponent } from './view-tabs.component';

describe('View tab scrolling', () => {
  it('maps vertical wheel units to horizontal browsing without selecting a tab', () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.componentRef.setInput('items', [{ id: 'app', title: 'App' }, { id: 'docs', title: 'Docs' }]);
    fixture.detectChanges();
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    const list = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    Object.defineProperties(list, { scrollWidth: { value: 1200 }, clientWidth: { value: 300 } });
    for (const [deltaMode, distance] of [[0, 2], [1, 32], [2, 600]]) {
      list.scrollLeft = 0;
      const event = new WheelEvent('wheel', { deltaY: 2, deltaMode, bubbles: true, cancelable: true });
      list.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(list.scrollLeft).toBe(distance);
    }
    expect(selected).not.toHaveBeenCalled();
    expect(list.querySelector('[aria-selected="true"]')?.getAttribute('data-tab-id')).toBe('app');
  });

  it('preserves native horizontal scrolling and zoom gestures', () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    Object.defineProperties(list, { scrollWidth: { value: 1200 }, clientWidth: { value: 300 } });
    for (const options of [{ deltaX: 40, deltaY: 3 }, { deltaY: 40, ctrlKey: true }]) {
      const event = new WheelEvent('wheel', { ...options, bubbles: true, cancelable: true });
      list.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(list.scrollLeft).toBe(0);
    }
  });

  it('leaves page scrolling available when tabs fit', () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('[role="tablist"]') as HTMLElement;
    Object.defineProperties(list, { scrollWidth: { value: 300 }, clientWidth: { value: 300 } });
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    list.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(list.scrollLeft).toBe(0);
  });

  it('keeps selection, closing and creation unavailable while disabled', () => {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.componentRef.setInput('items', [{ id: 'app', title: 'App' }, { id: 'docs', title: 'Docs' }]);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const intent = vi.fn();
    fixture.componentInstance.selected.subscribe(intent);
    fixture.componentInstance.closed.subscribe(intent);
    fixture.componentInstance.added.subscribe(intent);
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      button.click();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    }
    expect(intent).not.toHaveBeenCalled();
  });
});
