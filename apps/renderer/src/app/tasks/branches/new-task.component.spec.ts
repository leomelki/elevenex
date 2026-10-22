import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedTask, PlannedTask } from '../task.models';
import { NewTaskComponent } from './new-task.component';

describe('NewTask keyboard flow', () => {
  let fixture: ComponentFixture<NewTaskComponent>;
  beforeEach(async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await TestBed.configureTestingModule({
      imports: [NewTaskComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(NewTaskComponent);
    fixture.componentRef.setInput('project', {
      name: 'Elevenex',
      hue: 'ocean',
    });
    fixture.componentRef.setInput('branches', [
      { name: 'main', isDefault: true },
      { name: 'feature/existing' },
      { name: 'feature/held', task: 'Other task' },
    ]);
    fixture.componentRef.setInput('autoFocus', false);
  });
  function field(label: string): HTMLInputElement {
    const element = fixture.nativeElement.querySelector(
      `input[aria-label="${label}"]`,
    );
    if (!(element instanceof HTMLInputElement))
      throw new Error(`Missing ${label} input`);
    return element;
  }
  function key(
    element: HTMLElement,
    keyValue: string,
    options: KeyboardEventInit = {},
  ): void {
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyValue,
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
    fixture.detectChanges();
  }
  function name(value: string): void {
    const input = field('Task name');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  }

  it('creates a new branch from the project default with three Enter presses', () => {
    const created: CreatedTask[] = [];
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.detectChanges();
    name('Rate-limit refunds');
    key(field('Task name'), 'Enter');
    key(field('Branch: type to search or create'), 'Enter');
    key(field('Start from'), 'Enter');
    expect(created).toEqual([
      {
        title: 'Rate-limit refunds',
        branch: 'rate-limit-refunds',
        existing: false,
        base: 'main',
        workspace: 'auto',
      },
    ]);
  });
  it('uses an existing branch immediately and skips the base', () => {
    const created: CreatedTask[] = [];
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.componentRef.setInput('title', 'Existing task');
    fixture.componentRef.setInput('branchQuery', 'feature/existing');
    fixture.detectChanges();
    key(field('Task name'), 'Enter');
    key(field('Branch: type to search or create'), 'Enter');
    expect(created[0]).toMatchObject({
      branch: 'feature/existing',
      existing: true,
      base: null,
    });
  });
  it('does not create a held or invalid branch', () => {
    const create = vi.fn();
    fixture.componentInstance.create.subscribe(create);
    fixture.componentRef.setInput('title', 'Held task');
    fixture.componentRef.setInput('branchQuery', 'feature/held');
    fixture.detectChanges();
    key(field('Task name'), 'Enter');
    key(field('Branch: type to search or create'), 'Enter');
    key(field('Branch: type to search or create'), 'Enter', { metaKey: true });
    expect(create).not.toHaveBeenCalled();
    const input = field('Branch: type to search or create');
    input.value = 'invalid..branch';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    key(input, 'Enter');
    expect(create).not.toHaveBeenCalled();
  });
  it('saves Planned with Alt Enter, creates immediately with Cmd Enter, and cancels with Escape', () => {
    const plans: PlannedTask[] = [];
    const created: CreatedTask[] = [];
    const cancel = vi.fn();
    fixture.componentInstance.plan.subscribe((value) => plans.push(value));
    fixture.componentInstance.create.subscribe((value) => created.push(value));
    fixture.componentInstance.cancelled.subscribe(cancel);
    fixture.detectChanges();
    name('Fix retries');
    key(field('Task name'), 'Enter', { altKey: true });
    expect(plans[0]).toMatchObject({
      title: 'Fix retries',
      branch: 'fix-retries',
    });
    key(field('Task name'), 'Enter', { metaKey: true });
    expect(created[0]?.base).toBe('main');
    key(field('Task name'), 'Escape');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('goes back without discarding the draft', () => {
    fixture.detectChanges();
    name('Preserve me');
    key(field('Task name'), 'Enter');
    key(field('Branch: type to search or create'), 'Tab', { shiftKey: true });
    expect(field('Task name').value).toBe('Preserve me');
    expect(
      field('Task name').closest('ex-fold')?.getAttribute('aria-hidden'),
    ).toBe('false');
  });
  it('moves focus to the next field and selects the inferred answer immediately', async () => {
    fixture.componentRef.setInput('autoFocus', true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.activeElement).toBe(field('Task name'));
    name('Focus the branch');
    key(field('Task name'), 'Enter');
    await fixture.whenStable();
    const branch = field('Branch: type to search or create');
    expect(document.activeElement).toBe(branch);
    expect(branch.selectionStart).toBe(0);
    expect(branch.selectionEnd).toBe(branch.value.length);
  });
});
