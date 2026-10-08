import { OverlayContainer } from '@angular/cdk/overlay';
import { CdkTrapFocus, InteractivityChecker } from '@angular/cdk/a11y';
import { TestBed } from '@angular/core/testing';
import { getDebugNode } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTasksDrawerComponent } from './claude-tasks-drawer.component';

describe('ClaudeTasksDrawerComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.querySelector('[data-test-drawer-trigger]')?.remove();
  });

  async function openDrawer() {
    const trigger = document.createElement('button');
    trigger.dataset['testDrawerTrigger'] = '';
    document.body.append(trigger);
    trigger.focus();
    TestBed.configureTestingModule({ imports: [ClaudeTasksDrawerComponent] });
    // jsdom has no layout. Model visibility while retaining CDK's real focusability
    // checks, focus trap, and native focus/restoration behavior.
    vi.spyOn(TestBed.inject(InteractivityChecker), 'isVisible').mockReturnValue(true);
    const fixture = TestBed.createComponent(ClaudeTasksDrawerComponent);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    await fixture.whenStable();
    const container = TestBed.inject(OverlayContainer).getContainerElement();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    return { fixture, container, dialog, trigger };
  }

  it('opens a named modal with focus trapping and restores focus on dismissal', async () => {
    const { fixture, dialog, trigger } = await openDrawer();
    expect(dialog.getAttribute('aria-label')).toBe('Agent steps');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const button = dialog.querySelector<HTMLButtonElement>('[aria-label="Close agent steps"]')!;
    expect(button).not.toBeNull();
    expect(document.activeElement).toBe(button);
    // Assert the real CDK focus trap is attached and enabled, rather than a CSS marker.
    const trap = getDebugNode(dialog)?.injector.get(CdkTrapFocus);
    expect(trap?.enabled).toBe(true);
    expect(trap?.autoCapture).toBe(true);

    vi.useFakeTimers();
    fixture.componentRef.setInput('open', false);
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    expect(document.activeElement).toBe(trigger);
    expect(dialog.isConnected).toBe(false);
  });

  it('emits close once on Escape after the sheet is disposed', async () => {
    const { fixture, dialog } = await openDrawer();
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    vi.useFakeTimers();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialog.isConnected).toBe(false);
  });

  it('disposes an open sheet when the owner is destroyed without emitting close', async () => {
    const { fixture, dialog } = await openDrawer();
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    vi.useFakeTimers();
    fixture.destroy();
    vi.advanceTimersByTime(300);
    expect(dialog.isConnected).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('renders live task input updates inside the open sheet', async () => {
    const { fixture, dialog } = await openDrawer();
    expect(dialog.textContent).toContain('No agent steps yet');
    fixture.componentRef.setInput('tasks', [
      {
        taskId: 'task-1',
        status: 'running',
        subject: 'Inspect files',
        updatedAt: '2026-10-02T10:00:00Z',
      },
    ]);
    fixture.detectChanges();
    expect(dialog.textContent).toContain('Inspect files');
    expect(dialog.textContent).not.toContain('No agent steps yet');
  });
});
