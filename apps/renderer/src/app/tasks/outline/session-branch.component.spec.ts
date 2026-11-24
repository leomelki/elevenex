import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionBranchComponent } from './session-branch.component';
import type { TaskSession } from '../task.models';
const root: TaskSession = { id: '1', title: 'Plan', status: 'running', childCount: 1 };
const child: TaskSession = { id: '2', title: 'Implementation', status: 'done', parentId: '1' };
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
function setup(children: readonly TaskSession[] = [child]) {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const fixture = TestBed.createComponent(SessionBranchComponent);
  const parent = { ...root, childCount: children.length };
  fixture.componentRef.setInput('session', parent);
  fixture.componentRef.setInput('sessions', [parent, ...children]);
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

  it('caps the mixed child list at two and reveals all running and finished delegates together', () => {
    const running: TaskSession = { ...child, kind: 'delegated', status: 'running' };
    const children: readonly TaskSession[] = [
      running,
      { ...running, id: '3' },
      { ...running, id: '4' },
      { ...running, id: '5', status: 'done' },
    ];
    const fixture = setup(children);
    const host: HTMLElement = fixture.nativeElement;
    const visible = () => [...host.querySelectorAll<HTMLElement>('.children [data-session-id]')]
      .filter(row => !row.closest('[inert]')).map(row => row.dataset['sessionId']);
    const disclosure = host.querySelector<HTMLButtonElement>('.disclosure')!;
    disclosure.click();
    fixture.detectChanges();
    expect(visible()).toEqual(['4', '5']);

    const more = host.querySelector<HTMLButtonElement>('.child-cap')!;
    expect(more.textContent).toContain('Show 2 more');
    more.click();
    fixture.detectChanges();
    expect(visible()).toEqual(['2', '3', '4', '5']);
    const firstRow = host.querySelector('[data-session-id="2"]');
    fixture.componentRef.setInput('sessions', [root, { ...running, status: 'done' }, ...children.slice(1)]);
    fixture.detectChanges();
    expect(visible()).toEqual(['2', '3', '4', '5']);
    expect(host.querySelector('[data-session-id="2"]')).toBe(firstRow);

    fixture.componentRef.setInput('selected', '2');
    fixture.detectChanges();
    more.click();
    fixture.detectChanges();
    expect(visible()).toEqual(['2', '5']);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });
});
