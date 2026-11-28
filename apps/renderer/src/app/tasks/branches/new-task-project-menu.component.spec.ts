import { OverlayContainer } from '@angular/cdk/overlay';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DropdownMenuComponent, DropdownRadioComponent } from '../../ui';
import { NewTaskComponent } from './new-task.component';

@Component({
  imports: [NewTaskComponent, DropdownMenuComponent, DropdownRadioComponent],
  template: `
    <ex-new-task [project]="{ name: 'First project' }" [projectMenu]="menu"
      [active]="active()" [autoFocus]="false" (cancelled)="cancelled()"
      (projectRequested)="requested()" />
    <ng-template #menu>
      <ex-dropdown-menu label="Task project">
        <button exDropdownRadio [checked]="true">First project</button>
        <button exDropdownRadio (triggered)="changed('second')">Second project</button>
      </ex-dropdown-menu>
    </ng-template>
  `,
})
class ProjectMenuHost {
  readonly active = signal(true);
  readonly cancelled = vi.fn();
  readonly requested = vi.fn();
  readonly changed = vi.fn();
}

function key(element: Element, name: string, keyCode: number): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: name, keyCode, bubbles: true, cancelable: true }));
}

describe('New task project menu', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
  });

  function setup() {
    const fixture = TestBed.createComponent(ProjectMenuHost);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('button.project') as HTMLButtonElement;
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    return { fixture, trigger, overlay };
  }

  it('opens directly from the header, selects by keyboard and restores focus', async () => {
    const { fixture, trigger, overlay } = setup();
    trigger.focus(); key(trigger, 'ArrowDown', 40);
    fixture.detectChanges(); await fixture.whenStable();
    const items = overlay.querySelectorAll('[role="menuitemradio"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(fixture.componentInstance.requested).not.toHaveBeenCalled();
    key(items[0]!, 'ArrowDown', 40); key(items[1]!, 'Enter', 13);
    fixture.detectChanges();
    expect(fixture.componentInstance.changed).toHaveBeenCalledExactlyOnceWith('second');
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('dismisses Escape without cancelling the task or losing its draft', async () => {
    const { fixture, trigger, overlay } = setup();
    const name = fixture.nativeElement.querySelector('input[aria-label="Task name"]') as HTMLInputElement;
    name.value = 'Keep this draft'; name.dispatchEvent(new Event('input', { bubbles: true }));
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    key(overlay.querySelector('[role="menuitemradio"]')!, 'Escape', 27);
    fixture.detectChanges();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fixture.componentInstance.cancelled).not.toHaveBeenCalled();
    expect(name.value).toBe('Keep this draft');
  });

  it.each(['inactive', 'destroyed'])('disposes the open menu when %s', async state => {
    const { fixture, trigger, overlay } = setup();
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(overlay.querySelector('[role="menu"]')).not.toBeNull();
    if (state === 'destroyed') fixture.destroy();
    else {
      fixture.componentInstance.active.set(false);
      fixture.detectChanges(); await fixture.whenStable();
      expect(trigger.disabled).toBe(true);
    }
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
  });
});
