import { TestBed } from '@angular/core/testing';
import { ViewTabsComponent } from './view-tabs.component';
import { By } from '@angular/platform-browser';
import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';

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

describe('View tab ordering', () => {
  function setup() {
    const fixture = TestBed.createComponent(ViewTabsComponent);
    fixture.componentRef.setInput('items', ['app', 'docs', 'logs'].map(id => ({ id, title: id })));
    fixture.componentRef.setInput('active', 'docs');
    fixture.componentRef.setInput('reorderable', true);
    fixture.componentRef.setInput('detachable', true);
    fixture.detectChanges();
    const moved = vi.fn(), detached = vi.fn(), selected = vi.fn();
    fixture.componentInstance.moved.subscribe(moved);
    fixture.componentInstance.windowRequested.subscribe(detached);
    fixture.componentInstance.selected.subscribe(selected);
    const drag: CdkDrag<string> = fixture.debugElement.queryAll(By.directive(CdkDrag))[1]!.injector.get(CdkDrag);
    const list: CdkDropList = fixture.debugElement.query(By.directive(CdkDropList)).injector.get(CdkDropList);
    const start = () => drag.started.emit({ source: drag, event: new MouseEvent('mousedown') });
    const drop = (inside = true, y = 0) => list.dropped.emit({ item: drag, previousIndex: 1, currentIndex: 0, isPointerOverContainer: inside, dropPoint: { x: 10, y } } as CdkDragDrop<unknown, unknown, string>);
    return { fixture, moved, detached, selected, start, drop };
  }
  it('moves the focused tab by stable identity without selecting another tab', () => {
    const { fixture, moved, selected } = setup();
    const tab = fixture.nativeElement.querySelector('[data-tab-id="docs"]') as HTMLButtonElement;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true, bubbles: true }));
    expect(moved).toHaveBeenCalledExactlyOnceWith({ tabId: 'docs', beforeTabId: 'app' });
    expect(selected).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tab);
    fixture.componentRef.setInput('tabsBusy', true); fixture.detectChanges();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true }));
    expect(moved).toHaveBeenCalledTimes(1);
  });
  it('emits insertion and deliberate vertical tear-off intents separately', () => {
    const { moved, detached, start, drop } = setup();
    start(); drop();
    expect(moved).toHaveBeenCalledExactlyOnceWith({ tabId: 'docs', beforeTabId: 'app' });
    start(); drop(false, 20);
    expect(detached).not.toHaveBeenCalled();
    start(); drop(false, 100);
    expect(detached).toHaveBeenCalledExactlyOnceWith('docs');
    expect(moved).toHaveBeenCalledTimes(1);
  });
  it('cancels a drop when tab membership changes or Escape is pressed', () => {
    const { fixture, moved, detached, start, drop } = setup();
    start();
    fixture.componentRef.setInput('items', [{ id: 'docs', title: 'docs' }, { id: 'logs', title: 'logs' }]); fixture.detectChanges();
    drop(); expect(moved).not.toHaveBeenCalled();
    start();
    fixture.nativeElement.querySelector('[data-tab-id="docs"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    drop(false, 100); expect(detached).not.toHaveBeenCalled();
  });
});
