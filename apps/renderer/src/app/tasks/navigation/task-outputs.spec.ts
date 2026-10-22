import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchChipComponent } from '../branches/branch-chip.component';
import { TaskStageComponent } from '../lifecycle/task-stage.component';
import { CloseTaskComponent } from '../lifecycle/close-task.component';
import { GitBarComponent } from './git-bar.component';
import { PanelTabsComponent } from './panel-tabs.component';

describe('task component intents', () => {
  beforeEach(() =>
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('exposes branch rename and copy without accessing the clipboard', () => {
    const fixture = TestBed.createComponent(BranchChipComponent);
    fixture.componentRef.setInput('name', 'feature/retries');
    const rename = vi.fn();
    const copy = vi.fn();
    fixture.componentInstance.renameRequested.subscribe(rename);
    fixture.componentInstance.copyRequested.subscribe(copy);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.name').click();
    fixture.nativeElement.querySelector('.copy').click();
    expect(rename).toHaveBeenCalledWith('feature/retries');
    expect(copy).toHaveBeenCalledWith('feature/retries');
    fixture.componentRef.setInput('copied', true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.copy').getAttribute('aria-label'),
    ).toBe('Copied');
  });

  it('keeps one git action button across commit, busy and push states', () => {
    const fixture = TestBed.createComponent(GitBarComponent);
    fixture.componentRef.setInput('files', 7);
    const action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.split button');
    button.click();
    expect(action).toHaveBeenLastCalledWith('commit');
    fixture.componentRef.setInput('busy', 'commit');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.split button')).toBe(button);
    expect(button.disabled).toBe(true);
    fixture.componentRef.setInput('busy', undefined);
    fixture.componentRef.setInput('files', 0);
    fixture.componentRef.setInput('ahead', 2);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.split button')).toBe(button);
    button.click();
    expect(action).toHaveBeenLastCalledWith('push');
    fixture.componentRef.setInput('ahead', 0);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Up to date');
    expect(button.closest('[inert]')).not.toBeNull();
  });

  it('navigates panel tabs with arrows and End, emitting stable ids', () => {
    const fixture = TestBed.createComponent(PanelTabsComponent);
    fixture.componentRef.setInput('tabs', [
      { id: 'terminal', label: 'Terminal', icon: 'terminal' },
      { id: 'changes', label: 'Changes', icon: 'changes' },
      { id: 'browser', label: 'Browser', icon: 'globe' },
    ]);
    fixture.componentRef.setInput('active', 'terminal');
    const select = vi.fn();
    fixture.componentInstance.selectTab.subscribe(select);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('[role="tab"]');
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(select).toHaveBeenLastCalledWith('changes');
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    expect(select).toHaveBeenLastCalledWith('browser');
  });

  it('reports whether to push and move a linked ticket when closing', () => {
    const fixture = TestBed.createComponent(CloseTaskComponent);
    fixture.componentRef.setInput('title', 'Fix retries');
    fixture.componentRef.setInput('sessions', 3);
    fixture.componentRef.setInput('unpushed', 2);
    fixture.componentRef.setInput('ticket', 'PAY-212');
    const confirmed = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);
    fixture.detectChanges();
    const checkbox: HTMLInputElement =
      fixture.nativeElement.querySelector('input');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const buttons: NodeListOf<HTMLButtonElement> =
      fixture.nativeElement.querySelectorAll('footer button');
    buttons[buttons.length - 1]?.click();
    expect(confirmed).toHaveBeenCalledWith({ push: true, moveTicket: false });
    buttons[buttons.length - 2]?.click();
    expect(confirmed).toHaveBeenLastCalledWith({
      push: false,
      moveTicket: false,
    });
  });
  it('uses the CDK stage menu and restores trigger focus on Escape', async () => {
    const fixture = TestBed.createComponent(TaskStageComponent);
    fixture.detectChanges();
    const trigger: HTMLButtonElement =
      fixture.nativeElement.querySelector('.stage');
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const option = document.querySelector<HTMLElement>(
      '[role="menuitemradio"]',
    );
    expect(option).not.toBeNull();
    option?.focus();
    option?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        // CDK reads the browser's legacy keyCode; jsdom does not derive it from key.
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      }),
    );
    await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
