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
    expect(document.querySelector('ex-session-drag-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('.drop-active')).toBeNull();
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
    await Promise.resolve();
    expect(document.querySelector('ex-session-drag-preview')).toBeNull(); outside.remove();
  });
});
