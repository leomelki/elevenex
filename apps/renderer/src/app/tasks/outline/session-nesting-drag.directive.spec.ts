import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionNestingDragDirective } from './session-nesting-drag.directive';
import { SessionBranchComponent } from './session-branch.component';
import { SESSION_DRAG_TYPE } from '../session-drag';
import type { SessionMoveIntent, TaskSession } from '../task.models';
const root: TaskSession = { id: '1', title: 'Plan', status: 'done', childCount: 1 };
const child: TaskSession = { id: '2', title: 'Tests', status: 'done', parentId: '1' };
const leaf: TaskSession = { id: '3', title: 'Docs', status: 'done' };
@Component({
  imports: [SessionNestingDragDirective, SessionBranchComponent],
  template: `<article exSessionNestingDrag [dragSessions]="rows()" dragTaskId="task" [dragEnabled]="enabled()" (sessionDropped)="moves.push($event)"><header data-session-task-header>Task</header>@for (row of rows(); track row.id) { @if (!row.parentId) {<ex-session-branch [session]="row" [sessions]="rows()" [selected]="'2'" [allowNesting]="true" />}}</article>`,
})
class Harness {
  readonly rows = signal<readonly TaskSession[]>([root, child, leaf]);
  readonly enabled = signal(true);
  readonly moves: SessionMoveIntent[] = [];
}
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const fixture = TestBed.createComponent(Harness); fixture.detectChanges();
  const data = new Map<string, string>();
  const transfer = { effectAllowed: '', dropEffect: '', setData: vi.fn((type: string, value: string) => data.set(type, value)), setDragImage: vi.fn(), getData: (type: string) => type === SESSION_DRAG_TYPE ? data.get(type) ?? '' : '' };
  const send = (selector: string, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    fixture.nativeElement.querySelector(selector).dispatchEvent(event); fixture.detectChanges(); return event;
  };
  return { fixture, send, transfer };
}
describe('task-owned nesting drag', () => {
  it('targets the whole group through a child and drops exactly once, releasing its overlay', () => {
    const { fixture, send, transfer } = setup();
    send('[data-session-id="3"] .select', 'dragstart');
    expect(transfer.effectAllowed).toBe('copyMove');
    expect(transfer.setDragImage).toHaveBeenCalled();
    expect(document.querySelector('ex-session-drag-preview')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('ex-session-drag-preview')?.parentElement?.style.pointerEvents).toBe('none');
    expect(send('[data-session-id="2"] .select', 'dragover').defaultPrevented).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-session-root="1"]').classList.contains('drop-active')).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Nest Docs under Plan');
    send('[data-session-id="2"] .select', 'drop');
    expect(fixture.componentInstance.moves).toEqual([{ sessionId: '3', parentSessionId: '1' }]);
    expect(fixture.nativeElement.querySelector('.drop-active')).toBeNull();
    // The ghost holds its slot, and the count includes it, until the confirmed row arrives.
    expect(document.querySelector('ex-session-drag-preview.landing')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-session-root="1"] .child-count.pending')).not.toBeNull();
    // No dragend or backend reply is needed to release the original row.
    expect(fixture.nativeElement.querySelector('.drag-source, .dragging, .receded, .unavailable')).toBeNull();
    send('[data-session-id="2"] .select', 'drop');
    expect(fixture.componentInstance.moves).toHaveLength(1);
    fixture.componentInstance.rows.set([{ ...root, childCount: 2 }, child, { ...leaf, parentId: '1' }]); fixture.detectChanges();
    expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('.child-count.pending')).toBeNull();
  });
  it('releases an unconfirmed landing after a bounded hold', () => {
    vi.useFakeTimers();
    try {
      const { fixture, send } = setup();
      send('[data-session-id="3"] .select', 'dragstart');
      send('[data-session-id="1"] .select', 'dragover');
      send('[data-session-id="1"] .select', 'drop');
      expect(document.querySelector('ex-session-drag-preview')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('.drag-source, .dragging')).toBeNull();
      vi.advanceTimersByTime(1500); fixture.detectChanges();
      expect(document.querySelector('ex-session-drag-preview')).toBeNull();
      expect(fixture.nativeElement.querySelector('.drag-source')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('recedes groups that cannot accept the dragged session and readies the header for a child', () => {
    const { fixture, send } = setup();
    send('[data-session-id="2"] .select', 'dragstart');
    expect(fixture.nativeElement.querySelector('[data-session-root="1"]').classList.contains('unavailable')).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-session-root="3"]').classList.contains('unavailable')).toBe(false);
    expect(fixture.nativeElement.querySelector('header').classList.contains('session-drop-ready')).toBe(true);
    send('header', 'dragover');
    expect(fixture.nativeElement.querySelector('.drag-source').classList.contains('outdent-preview')).toBe(true);
    document.dispatchEvent(new Event('dragend')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.unavailable, .outdent-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('header').classList.contains('session-drop-ready')).toBe(false);
  });
  it('rejects self and populated sources, permits child drag-out on the header', () => {
    const { fixture, send } = setup();
    send('[data-session-id="1"] .select', 'dragstart');
    expect(send('[data-session-id="3"] .select', 'dragover').defaultPrevented).toBe(false);
    send('[data-session-id="3"] .select', 'drop');
    send('[data-session-id="2"] .select', 'dragstart');
    expect(send('[data-session-id="2"] .select', 'dragover').defaultPrevented).toBe(false);
    expect(send('header', 'dragover').defaultPrevented).toBe(true);
    expect(fixture.nativeElement.querySelector('header').classList.contains('session-drop-root')).toBe(true);
    send('header', 'drop');
    expect(fixture.componentInstance.moves).toEqual([{ sessionId: '2', parentSessionId: null }]);
    expect(fixture.nativeElement.querySelector('.drag-source, .dragging, .outdent-preview')).toBeNull();
  });
  it('cancels on Escape, disabling, blur and destruction without a mutation', () => {
    const { fixture, send } = setup();
    const begin = () => { send('[data-session-id="3"] .select', 'dragstart'); send('[data-session-id="1"] .select', 'dragover'); };
    begin(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    begin(); fixture.componentInstance.enabled.set(false); fixture.detectChanges();
    expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    fixture.componentInstance.enabled.set(true); fixture.detectChanges(); begin(); window.dispatchEvent(new Event('blur'));
    expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    begin(); fixture.destroy(); expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    expect(fixture.componentInstance.moves).toEqual([]);
  });
  it('leaves composer and foreign-task drops to their owners with the native transfer intact', async () => {
    const { fixture, send } = setup();
    send('[data-session-id="3"] .select', 'dragstart');
    const outside = document.createElement('div'); document.body.append(outside);
    const event = new Event('drop', { bubbles: true, cancelable: true }); outside.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(fixture.componentInstance.moves).toEqual([]);
    await Promise.resolve(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.drag-source, .dragging')).toBeNull();
    expect(document.querySelector('ex-session-drag-preview')).toBeNull(); outside.remove();
  });
});
