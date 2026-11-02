import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { DropdownComponent } from './dropdown.component';
import { TaskStageComponent } from '../../tasks/lifecycle/task-stage.component';
import { WorkspacePickerComponent } from '../../tasks/branches/workspace-picker.component';

function key(element: Element, name: string, keyCode: number): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: name, keyCode, bubbles: true, cancelable: true }));
}

describe('Shared dropdown public behavior', () => {
  function choice() {
    const fixture = TestBed.createComponent(DropdownComponent);
    fixture.componentRef.setInput('label', 'Default preset');
    fixture.componentRef.setInput('value', 'deep');
    fixture.componentRef.setInput('options', [
      { id: 'deep', label: 'Deep work', detail: 'High', mark: 'Cl' },
      { id: 'unavailable', label: 'Unavailable', disabled: true },
      { id: 'quick', label: 'Quick edit' },
    ]);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    return { fixture, trigger, overlay };
  }

  it('supports a quiet prefixed trigger without changing accessible selection or menu labels', async () => {
    const { fixture, trigger, overlay } = choice();
    fixture.componentRef.setInput('appearance', 'quiet');
    fixture.componentRef.setInput('prefix', 'Default:'); fixture.detectChanges();
    expect(trigger.classList.contains('quiet')).toBe(true);
    expect(trigger.textContent).toContain('Default:');
    expect(trigger.getAttribute('aria-label')).toBe('Default preset: Deep work');
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(overlay.querySelector('[role="menuitemradio"]')?.textContent).toContain('Deep work');
    expect(overlay.querySelector('[role="menuitemradio"]')?.textContent).not.toContain('Default:');
  });
  it('opens with the keyboard, announces disabled items and emits a controlled choice with restored focus', async () => {
    const { fixture, trigger, overlay } = choice();
    const changed = vi.fn();
    fixture.componentInstance.changed.subscribe(changed);
    trigger.focus();
    key(trigger, 'ArrowDown', 40);
    fixture.detectChanges(); await fixture.whenStable();
    const items = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(items).toHaveLength(3);
    expect(overlay.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Default preset');
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    expect(items[1]!.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, 'ArrowDown', 40);
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, 'Enter', 13);
    expect(changed).not.toHaveBeenCalled();
    key(items[1]!, 'ArrowDown', 40);
    expect(document.activeElement).toBe(items[2]);
    key(items[2]!, 'Enter', 13);
    fixture.detectChanges();
    expect(changed).toHaveBeenCalledExactlyOnceWith('quick');
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain('Deep work');
    fixture.componentRef.setInput('value', 'quick'); fixture.detectChanges();
    expect(trigger.textContent).toContain('Quick edit');
  });

  it('supports typeahead and dismisses Escape locally without changing the value', async () => {
    const { fixture, trigger, overlay } = choice();
    const changed = vi.fn(); fixture.componentInstance.changed.subscribe(changed);
    trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    const items = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    items[0]!.focus(); key(items[0]!, 'q', 81);
    await vi.waitFor(() => expect(document.activeElement).toBe(items[2]));
    const escaped = vi.fn(); fixture.nativeElement.addEventListener('keydown', escaped);
    key(items[2]!, 'Escape', 27); fixture.detectChanges();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(changed).not.toHaveBeenCalled();
    expect(escaped).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'active', 'destroyed'])('releases an open overlay when %s', async state => {
    const { fixture, trigger, overlay } = choice();
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(overlay.querySelector('[role="menu"]')).not.toBeNull();
    if (state === 'destroyed') fixture.destroy();
    else {
      fixture.componentRef.setInput(state, state === 'disabled');
      fixture.detectChanges(); await fixture.whenStable();
      expect(trigger.disabled).toBe(true);
    }
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
  });

  it('displays unknown values without inventing options, and disables empty or wholly unavailable lists', () => {
    const { fixture, trigger, overlay } = choice();
    fixture.componentRef.setInput('value', 'removed-preset'); fixture.detectChanges();
    expect(trigger.textContent).toContain('removed-preset');
    fixture.componentRef.setInput('options', []); fixture.detectChanges();
    expect(trigger.disabled).toBe(true);
    trigger.click(); expect(overlay.querySelector('[role="menu"]')).toBeNull();
    fixture.componentRef.setInput('options', [{ id: 'offline', label: 'Offline', disabled: true }]); fixture.detectChanges();
    expect(trigger.disabled).toBe(true);
  });

  it('preserves task-stage intent through projected radio items', async () => {
    const fixture = TestBed.createComponent(TaskStageComponent);
    fixture.componentRef.setInput('stage', 'active');
    const changed = vi.fn(); fixture.componentInstance.stageChange.subscribe(changed);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const items = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(items[1]!.getAttribute('aria-checked')).toBe('true');
    items[2]!.click(); fixture.detectChanges();
    expect(changed).toHaveBeenCalledExactlyOnceWith('waiting');
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('combines workspace choices and actions while preventing occupied workspace selection', async () => {
    const fixture = TestBed.createComponent(WorkspacePickerComponent);
    fixture.componentRef.setInput('items', [
      { name: 'workspace-1', state: 'used', task: 'Another task' },
      { name: 'workspace-2', state: 'free' },
    ]);
    const changed = vi.fn(); const created = vi.fn();
    fixture.componentInstance.valueChange.subscribe(changed); fixture.componentInstance.newWorkspace.subscribe(created);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click(); fixture.detectChanges(); await fixture.whenStable();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    const radios = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    radios[1]!.click(); expect(changed).not.toHaveBeenCalled();
    expect(radios[1]!.getAttribute('aria-disabled')).toBe('true');
    const actions = overlay.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    actions[0]!.click(); fixture.detectChanges();
    expect(created).toHaveBeenCalledOnce();
    expect(overlay.querySelector('[role="menu"]')).toBeNull();
  });
});
