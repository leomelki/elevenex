import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTask } from '@elevenex/shared';
import { WorkspaceTaskSetupComponent } from './workspace-task-setup.component';

const failed: WorkspaceTask = { id: 1, projectId: 2, repoId: 3, name: 'Continue existing work', branchName: 'feature/existing', stage: 'active', state: 'failed', archivedAt: null, updatedAt: '', setupIssue: { code: 'external-checkout', message: 'This branch is already checked out in another workspace.', workspacePath: '/work/existing', canUseSnapshot: true } };

describe('Saved task setup recovery', () => {
  it('offers explicit quota consent only when advertised and disables it during setup', () => {
    const fixture = TestBed.createComponent(WorkspaceTaskSetupComponent);
    fixture.componentRef.setInput('task', { ...failed, setupIssue: { code: 'other', message: 'This repository has 23 workspaces, meeting or exceeding the configured limit of 5.', canUseSnapshot: false, canExceedWorktreeLimit: true } });
    const retry = vi.fn(); fixture.componentInstance.retryRequested.subscribe(retry); fixture.detectChanges();
    expect(retry).not.toHaveBeenCalled();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button[data-variant="primary"]');
    expect(button.textContent).toContain('Create workspace anyway');
    button.click(); expect(retry).toHaveBeenCalledWith('exceed-worktree-limit');
    fixture.componentRef.setInput('busy', true); fixture.detectChanges();
    expect(button.disabled).toBe(true);
    fixture.componentRef.setInput('busy', false); fixture.componentRef.setInput('uncertain', true); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Create workspace anyway');
    expect(fixture.nativeElement.textContent).toContain('Refresh setup');
    fixture.componentRef.setInput('uncertain', false); fixture.componentRef.setInput('task', { ...failed, setupIssue: undefined }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Create workspace anyway');
  });
  it('explains the external checkout and emits consent only after an explicit action', () => {
    const fixture = TestBed.createComponent(WorkspaceTaskSetupComponent);
    fixture.componentRef.setInput('task', failed);
    const retry = vi.fn(); fixture.componentInstance.retryRequested.subscribe(retry); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('already checked out');
    expect(fixture.nativeElement.querySelector('code').textContent).toBe('/work/existing');
    expect(retry).not.toHaveBeenCalled();
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('button'));
    buttons.find(button => button.textContent?.includes('Use existing workspace'))?.click();
    expect(retry).toHaveBeenLastCalledWith('use-existing');
    buttons.find(button => button.textContent?.includes('Use committed revision'))?.click();
    expect(retry).toHaveBeenLastCalledWith('snapshot');
  });
  it('disables recovery while busy and offers only reconciliation after an uncertain write', () => {
    const fixture = TestBed.createComponent(WorkspaceTaskSetupComponent);
    fixture.componentRef.setInput('task', failed); fixture.componentRef.setInput('busy', true); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(Array.from(root.querySelectorAll<HTMLButtonElement>('button')).every(button => button.disabled)).toBe(true);
    fixture.componentRef.setInput('busy', false); fixture.componentRef.setInput('uncertain', true); fixture.detectChanges();
    const refresh = vi.fn(); fixture.componentInstance.refreshRequested.subscribe(refresh);
    const buttons = fixture.nativeElement.querySelectorAll('button');
    expect(buttons).toHaveLength(1); expect(buttons[0].textContent).toContain('Refresh setup');
    buttons[0].click(); expect(refresh).toHaveBeenCalledOnce();
  });
  it('never offers adoption for busy or owned branches and retains older-backend retry behavior', () => {
    const fixture = TestBed.createComponent(WorkspaceTaskSetupComponent);
    fixture.componentRef.setInput('task', { ...failed, setupIssue: { ...failed.setupIssue, code: 'environment-busy', message: 'Running work', canUseSnapshot: true } }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Use existing workspace');
    expect(fixture.nativeElement.textContent).toContain('Use committed revision');
    fixture.componentRef.setInput('task', { ...failed, setupIssue: undefined }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Retry setup');
    expect(fixture.nativeElement.textContent).not.toContain('Use committed revision');
  });
  it('offers a focused refresh after a rejected recovery and no setup actions after closure', () => {
    const fixture = TestBed.createComponent(WorkspaceTaskSetupComponent);
    fixture.componentRef.setInput('task', failed); fixture.componentRef.setInput('error', 'The saved task changed.'); fixture.detectChanges();
    const refresh = vi.fn(); fixture.componentInstance.refreshRequested.subscribe(refresh);
    fixture.nativeElement.querySelector('button.refresh').click(); expect(refresh).toHaveBeenCalledOnce();
    fixture.componentRef.setInput('task', { ...failed, state: 'finished' }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('This task has been closed');
    expect(fixture.nativeElement.querySelectorAll('button')).toHaveLength(0);
  });

});
