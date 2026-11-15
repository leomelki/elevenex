import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBranchComponent } from './session-branch.component';
import type { TaskSession } from '../task.models';
const root: TaskSession = { id: '1', title: 'Plan', status: 'running', childCount: 1 };
const child: TaskSession = { id: '2', title: 'Implementation', status: 'done', parentId: '1' };
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
function setup() {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const fixture = TestBed.createComponent(SessionBranchComponent);
  fixture.componentRef.setInput('session', root);
  fixture.componentRef.setInput('sessions', [root,child]);
  fixture.componentRef.setInput('allowNesting', true);
  fixture.detectChanges(); return fixture;
}
describe('session groups', () => {
  it('discloses children without activating the parent, and makes collapsed children inert', () => {
    const fixture = setup(), activated = vi.fn(), requested = vi.fn();
    fixture.componentInstance.activated.subscribe(activated);
    fixture.componentInstance.childrenRequested.subscribe(requested);
    const childRow = () => fixture.nativeElement.querySelector('[data-session-id="2"]');
    expect(childRow().closest('[inert]')).not.toBeNull();
    fixture.nativeElement.querySelector('.disclosure').click(); fixture.detectChanges();
    expect(requested).toHaveBeenCalledWith({ sessionId: '1' }); expect(activated).not.toHaveBeenCalled();
    expect(childRow().closest('[inert]')).toBeNull();
    fixture.nativeElement.querySelector('.disclosure').click(); fixture.detectChanges();
    expect(childRow().closest('[inert]')).not.toBeNull();
  });
  it('reveals a selected child and exposes a keyboard move to task level', () => {
    const fixture = setup(), moved = vi.fn();
    fixture.componentInstance.moveRequested.subscribe(moved);
    fixture.componentRef.setInput('selected','2'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-session-id="2"]').closest('[inert]')).toBeNull();
    const childBranch = fixture.nativeElement.querySelector('.children ex-session-branch');
    childBranch.querySelector('.move-menu').click(); fixture.detectChanges();
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent?.includes('Move to task level'));
    expect(item).toBeDefined(); item!.click(); fixture.detectChanges();
    expect(moved).toHaveBeenCalledWith({ sessionId: '2', parentSessionId: null });
  });
  it('accepts same-task leaves and rejects self, existing membership, populated groups and disabled drops', () => {
    const fixture = setup(), moved = vi.fn(); fixture.componentInstance.moveRequested.subscribe(moved);
    const row = fixture.nativeElement.querySelector('.branch-row');
    const drop = () => { const event = new Event('drop', { bubbles: true, cancelable: true }); row.dispatchEvent(event); return event.defaultPrevented; };
    for (const source of [root,child,{...child,id:'3',childCount:2}]) {
      fixture.componentRef.setInput('dragSource',source); fixture.detectChanges(); expect(drop()).toBe(false);
    }
    fixture.componentRef.setInput('dragSource',{ ...child,id:'3',parentId:null }); fixture.detectChanges();
    expect(drop()).toBe(true); expect(moved).toHaveBeenCalledWith({sessionId:'3',parentSessionId:'1'});
    fixture.componentRef.setInput('allowNesting',false); fixture.detectChanges(); expect(drop()).toBe(false);
  });
});
