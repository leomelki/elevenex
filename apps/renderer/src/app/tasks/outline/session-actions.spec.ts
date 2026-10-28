import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSession } from '../task.models';
import { SessionRowComponent } from './session-row.component';
import { TaskListComponent } from './task-list.component';
import { TaskGroupComponent } from './task-group.component';
import { sessionWindow } from './session-window';

const sessions: readonly TaskSession[] = Array.from({ length: 19 }, (_, index) => ({ id: String(index), title: `Session ${index}`, status: 'running' }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe('working session window', () => {
  it('shows the latest five and reveals earlier sessions in batches without changing their status/order', () => {
    const fixture = TestBed.createComponent(TaskGroupComponent);
    fixture.componentRef.setInput('task', { id: 'task', title: 'Busy task', sessions });
    fixture.detectChanges();
    const visible = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('ex-session-row')).filter(row => !row.closest('[inert]')).map(row => row.textContent?.trim());
    expect(visible()).toEqual(sessions.slice(-5).map(session => session.title));
    const more = () => fixture.nativeElement.querySelector('.earlier-more') as HTMLButtonElement;
    expect(more().textContent).toContain('14 older');
    expect(more().getAttribute('aria-label')).toBe('Show 5 older sessions (14 hidden)');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('.ghost')).toBeNull();
    more().click(); fixture.detectChanges(); expect(visible()).toHaveLength(10);
    expect(more().textContent).toContain('9 older');
    more().click(); fixture.detectChanges(); expect(visible()).toHaveLength(15);
    more().click(); fixture.detectChanges(); expect(visible()).toHaveLength(19);
    expect(more()).toBeNull();
    expect(fixture.nativeElement.querySelector('.earlier-fewer').getAttribute('aria-expanded')).toBe('true');
    fixture.nativeElement.querySelector('.earlier-fewer').click(); fixture.detectChanges();
    expect(visible()).toHaveLength(5);
    expect(sessions.every(session => session.status === 'running')).toBe(true);
  });
  it('keeps revealed survivors visible after refreshed task objects, additions and removals', () => {
    const fixture = TestBed.createComponent(TaskGroupComponent);
    const task = {id:'task',title:'Busy task',sessions};
    fixture.componentRef.setInput('task',task); fixture.detectChanges();
    const visible = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('ex-session-row .row')).filter(row=>!row.closest('[inert]')).map(row=>row.dataset['sessionId']);
    fixture.nativeElement.querySelector('.earlier-more').click(); fixture.detectChanges();
    expect(visible()).toEqual(sessions.slice(9).map(session=>session.id));
    fixture.componentRef.setInput('task',{...task,sessions:sessions.map(session=>({...session}))}); fixture.detectChanges();
    expect(visible()).toEqual(sessions.slice(9).map(session=>session.id));
    const remaining = sessions.filter(session=>session.id!=='11');
    fixture.componentRef.setInput('task',{...task,sessions:remaining}); fixture.detectChanges();
    expect(visible()).toEqual(remaining.slice(8).map(session=>session.id));
    fixture.componentRef.setInput('task',{...task,sessions:[...remaining,{id:'new',title:'New session',status:'queued'}]}); fixture.detectChanges();
    expect(visible()).toEqual([...remaining.slice(8).map(session=>session.id),'new']);
    while (fixture.nativeElement.querySelector('.earlier-more')) {
      fixture.nativeElement.querySelector('.earlier-more').click(); fixture.detectChanges();
    }
    fixture.componentRef.setInput('task',{...task,sessions:[...remaining,{id:'new',title:'New session',status:'queued'},{id:'newer',title:'Another session',status:'queued'}]}); fixture.detectChanges();
    expect(visible()).toHaveLength(20);
    expect(fixture.nativeElement.querySelector('.earlier-more')).toBeNull();
    fixture.componentRef.setInput('task',{id:'another',title:'Another task',sessions}); fixture.detectChanges();
    expect(visible()).toHaveLength(5);
  });
  it('retains each task disclosure through list replacement and owner remount, with a bounded cache', () => {
    let fixture = TestBed.createComponent(TaskListComponent);
    const task = {id:'task',title:'Busy task',sessions};
    fixture.componentRef.setInput('tasks',[task]); fixture.detectChanges();
    fixture.nativeElement.querySelector('.earlier-more').click(); fixture.detectChanges();
    const visible = () => Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('[data-task-id="task"] ex-session-row .row')).filter(row=>!row.closest('[inert]')).map(row=>row.dataset['sessionId']);
    const revealed = visible();
    fixture.componentRef.setInput('tasks',[]); fixture.detectChanges();
    fixture.componentRef.setInput('tasks',[task]); fixture.detectChanges(); expect(visible()).toEqual(revealed);
    const disclosure = fixture.componentInstance.sessionDisclosures(); fixture.destroy();
    fixture = TestBed.createComponent(TaskListComponent);
    fixture.componentRef.setInput('sessionDisclosures',disclosure); fixture.componentRef.setInput('tasks',[task]); fixture.detectChanges();
    expect(visible()).toEqual(revealed);
    const cached = disclosure.get('task')!;
    fixture.componentRef.setInput('sessionDisclosures',new Map(Array.from({length:200},(_,index)=>[`cached-${index}`,{...cached,taskId:`cached-${index}`}]))); fixture.detectChanges();
    fixture.nativeElement.querySelector('.earlier-more').click(); fixture.detectChanges();
    expect(fixture.componentInstance.sessionDisclosures().size).toBe(200);
    expect(fixture.componentInstance.sessionDisclosures().has('cached-0')).toBe(false);
    expect(fixture.componentInstance.sessionDisclosures().has('task')).toBe(true);
    fixture.nativeElement.querySelector('.earlier-fewer').click(); fixture.detectChanges();
    expect(fixture.componentInstance.sessionDisclosures().has('task')).toBe(false);
  });
  it('pins attention, failed, fresh and selected sessions, while filters and zero cap show every match', () => {
    const input: readonly TaskSession[] = sessions.map((session, index) => ({ ...session, ...(index === 0 ? {status: 'attention' as const} : index === 1 ? {status: 'failed' as const} : index === 2 ? {fresh: true} : {}) }));
    const window = sessionWindow(input, 5, '3', false);
    expect(window.hidden.size).toBe(10);
    for (const id of ['0', '1', '2', '3', '14', '18']) expect(window.hidden.has(id)).toBe(false);
    expect(sessionWindow(input, 0, null, false).hidden.size).toBe(0);
    expect(sessionWindow(input, 5, null, true).hidden.size).toBe(0);
    expect(sessionWindow(input, 5, '3', false, {taskId:'task', cap:5, hiddenIds:['4','5','6','7','8']}).hidden.has('8')).toBe(true);
  });
  it('keeps revealed selection and attention in their batch, then pins selection after Show fewer', () => {
    const disclosure = { taskId: 'task', cap: 5, hiddenIds: sessions.slice(0, 9).map(row => row.id), batches: [sessions.slice(9, 14).map(row => row.id)] };
    const changed = sessions.map(row => row.id === '10' ? { ...row, status: 'attention' as const } : row);
    const expanded = sessionWindow(changed, 5, '9', false, disclosure);
    expect(expanded.batches[0]?.sessions.map(row => row.id)).toEqual(['9', '10', '11', '12', '13']);
    expect(expanded.shown.some(row => row.id === '9' || row.id === '10')).toBe(false);
    expect(expanded.muted).toBeNull();
    const collapsed = sessionWindow(changed, 5, '9', false);
    expect(collapsed.shown.slice(0, 2).map(row => row.id)).toEqual(['9', '10']);
    expect(collapsed.muted).toBeNull();
  });
  it('backfills an archived batch at its top without moving its surviving rows', () => {
    const disclosure = { taskId: 'task', cap: 5, hiddenIds: sessions.slice(0, 9).map(row => row.id), batches: [sessions.slice(9, 14).map(row => row.id)] };
    const result = sessionWindow(sessions.filter(row => row.id !== '11'), 5, null, false, disclosure);
    expect(result.batches[0]?.sessions.map(row => row.id)).toEqual(['8', '9', '10', '12', '13']);
    expect(result.hidden.size).toBe(8);
    expect(result.muted).toBe('8');
  });
  it('carries archive gaps across several batches in chronological order', () => {
    const disclosure = { taskId: 'task', cap: 5, hiddenIds: ['0','1','2','3'], batches: [['9','10','11','12','13'], ['4','5','6','7','8']] };
    const result = sessionWindow(sessions.filter(row => row.id !== '11'), 5, null, false, disclosure);
    expect(result.batches.map(batch => batch.sessions.map(row => row.id))).toEqual([
      ['8','9','10','12','13'], ['3','4','5','6','7'],
    ]);
    expect([...result.hidden]).toEqual(['0','1','2']);
  });
  it('uncaps a session as soon as it needs attention', () => {
    expect(sessionWindow(sessions, 5, null, false).hidden.has('0')).toBe(true);
    expect(sessionWindow([{...sessions[0]!, status: 'attention'}, ...sessions.slice(1)], 5, null, false).hidden.has('0')).toBe(false);
  });
});

describe('session row archive intent', () => {
  function row(status: TaskSession['status']) {
    const fixture = TestBed.createComponent(SessionRowComponent);
    fixture.componentRef.setInput('session', { id: 'one', title: 'A long running session', status });
    fixture.componentRef.setInput('allowArchive', true);
    const archived = vi.fn(), activated = vi.fn();
    fixture.componentInstance.archiveRequested.subscribe(archived);
    fixture.componentInstance.activated.subscribe(activated);
    fixture.detectChanges();
    const archive = fixture.nativeElement.querySelector('.archive') as HTMLButtonElement;
    return { fixture, archive, archived, activated };
  }
  it.each(['queued', 'attention', 'review', 'failed', 'done'] as const)('archives %s in one click, without selecting it', status => {
    const { archive, archived, activated } = row(status);
    archive.click(); expect(archived).toHaveBeenCalledOnce(); expect(activated).not.toHaveBeenCalled();
  });
  it('confirms running sessions with a second click, and cancels on Escape, blur and outside input', () => {
    const { fixture, archive, archived } = row('running');
    archive.click(); fixture.detectChanges();
    expect(archived).not.toHaveBeenCalled();
    expect(archive.getAttribute('aria-label')).toContain('press again to confirm');
    archive.dispatchEvent(new Event('mouseleave')); fixture.detectChanges();
    expect(archive.getAttribute('aria-label')).toContain('press again to confirm');
    archive.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
    expect(archive.getAttribute('aria-label')).not.toContain('press again');
    archive.click(); archive.dispatchEvent(new FocusEvent('blur')); fixture.detectChanges();
    expect(archive.getAttribute('aria-label')).not.toContain('press again');
    archive.click(); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); fixture.detectChanges();
    expect(archive.getAttribute('aria-label')).not.toContain('press again');
    archive.click(); archive.click(); expect(archived).toHaveBeenCalledOnce();
  });
  it('hides the action when no archive owner is supplied and releases confirmation listeners on teardown', () => {
    const { fixture, archive } = row('running');
    archive.click(); const remove = vi.spyOn(document, 'removeEventListener'); fixture.destroy();
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    const view = TestBed.createComponent(SessionRowComponent);
    view.componentRef.setInput('session', sessions[0]); view.detectChanges();
    expect(view.nativeElement.querySelector('.archive')).toBeNull();
  });
});
