import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSessionArchive } from '../task.models';
import { ArchivedSessionsComponent } from './archived-sessions.component';

const archive: TaskSessionArchive = { sessions: [{ id: '1', title: 'Saved discussion', status: 'done' }], loading: false, loaded: true, more: true, earlier: false, error: null };
describe('archived session disclosure', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })));
  afterEach(() => vi.unstubAllGlobals());

  it('reveals a selected archive but allows manual collapse until another archive is selected', () => {
    const fixture = TestBed.createComponent(ArchivedSessionsComponent);
    const sessions = [...archive.sessions, { id: '2', title: 'Another discussion', status: 'done' as const }];
    fixture.componentRef.setInput('archive', { ...archive, sessions });
    fixture.componentRef.setInput('selected', '1'); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('.toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click(); fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('ex-session-row')!.closest('[inert]')).not.toBeNull();
    // A history refresh with the same selection must preserve the manual fold.
    fixture.componentRef.setInput('archive', { ...archive, sessions: [...sessions] }); fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click(); fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click(); fixture.detectChanges();
    fixture.componentRef.setInput('selected', '2'); fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fixture.destroy();
  });

  it('keeps collapsed rows inert, opens persisted history, and forwards selection and restore separately', () => {
    const fixture = TestBed.createComponent(ArchivedSessionsComponent);
    fixture.componentRef.setInput('archive', archive); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const row = root.querySelector('ex-session-row')!;
    expect(row.closest('[inert]')).not.toBeNull();
    const selected = vi.fn(), restored = vi.fn(), requested = vi.fn();
    fixture.componentInstance.selectSession.subscribe(selected);
    fixture.componentInstance.restoreRequested.subscribe(restored);
    fixture.componentInstance.requested.subscribe(requested);
    root.querySelector<HTMLButtonElement>('.toggle')!.click(); fixture.detectChanges();
    expect(row.closest('[inert]')).toBeNull();
    row.querySelector<HTMLButtonElement>('.select')!.click();
    expect(selected).toHaveBeenCalledWith('1');
    row.querySelector<HTMLButtonElement>('.restore')!.click();
    expect(restored).toHaveBeenCalledWith(archive.sessions[0]);
    expect(selected).toHaveBeenCalledTimes(1);
    const earlier = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('Earlier archived'))!;
    earlier.click(); expect(requested).toHaveBeenCalledWith('earlier');
    fixture.componentRef.setInput('disabled', true); fixture.detectChanges();
    expect(row.querySelector('.restore')).toBeNull(); expect(earlier.disabled).toBe(true);
  });

  it('requests unloaded history on open and exposes loading, retry and empty states', () => {
    const fixture = TestBed.createComponent(ArchivedSessionsComponent);
    fixture.componentRef.setInput('archive', { ...archive, loaded: false, sessions: [], more: false });
    const requested = vi.fn(); fixture.componentInstance.requested.subscribe(requested); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('.toggle')!.click(); fixture.detectChanges();
    expect(requested).toHaveBeenCalledWith('latest');
    fixture.componentRef.setInput('archive', { ...archive, loaded: false, loading: true, sessions: [] }); fixture.detectChanges();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Loading archived');
    fixture.componentRef.setInput('archive', { ...archive, error: 'Unavailable', sessions: [] }); fixture.detectChanges();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Unavailable');
    [...root.querySelectorAll('button')].find(button => button.textContent?.includes('Retry'))!.click();
    expect(requested).toHaveBeenCalledTimes(2);
    fixture.componentRef.setInput('archive', { ...archive, sessions: [] }); fixture.detectChanges();
    expect(root.textContent).toContain('No archived sessions.');
  });
});
