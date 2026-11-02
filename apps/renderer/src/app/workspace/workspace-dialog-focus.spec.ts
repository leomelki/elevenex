import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectComponent } from '../projects';
import { NewTaskComponent, TaskHeaderComponent } from '../tasks';
import { ModalLayerComponent } from '../ui';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskHeaderComponent } from './workspace-task-header.component';
import { WorkspaceTaskGitService } from './workspace-task-git.service';

@Component({
  imports: [ModalLayerComponent, NewTaskComponent, NewProjectComponent],
  template: `<ex-modal-layer [open]="open()"><section role="dialog" aria-label="Workspace draft">@if (kind() === 'task') { <ex-new-task [project]="{name:'Project'}" [autoFocus]="false" /> } @else { <ex-new-project [autoFocus]="false" /> }</section></ex-modal-layer>`,
})
class DraftHost { readonly open = signal(false); readonly kind = input<'task' | 'project'>('task'); }

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
  // JSDOM has no layout; provide painted dimensions for CDK's visibility check.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
});
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace dialog focus and native submission', () => {
  for (const kind of ['task', 'project'] as const) it(`lets the modal choose the ${kind === 'task' ? 'task name' : 'repository'} input without component autofocus`, async () => {
    const fixture = TestBed.createComponent(DraftHost);
    fixture.componentRef.setInput('kind', kind); fixture.detectChanges();
    fixture.componentInstance.open.set(true); fixture.detectChanges(); await fixture.whenStable();
    const field = document.querySelector<HTMLInputElement>(kind === 'task' ? 'input[aria-label="Task name"]' : 'ex-folder-suggestions input');
    expect(field).not.toBeNull(); expect(document.activeElement).toBe(field);
    fixture.destroy();
  });

  it('submits branch rename through a native form while Cancel stays a button', async () => {
    const selected = signal({ scopeId: 'scope', taskId: 1, sessionId: 2 });
    const store = {
      selected, selectedTask: () => ({ id: 1, projectId: 3, name: 'Task', branchName: 'work', state: 'ready' }),
      projects: () => [{ id: '3', name: 'Project' }], selectedTaskStage: () => 'active', busy: () => false,
      error: signal<string | null>(null), commitPanelAvailable: () => true,
    };
    const git = {
      summary: () => ({ branch: 'work', behind: 0 }), commitPreview: () => null, state: () => undefined,
      loading: () => false, busy: signal<string | null>(null), error: signal<string | null>(null),
      perform: vi.fn(async () => true),
    };
    TestBed.configureTestingModule({ providers: [{ provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: {} }] });
    TestBed.overrideComponent(WorkspaceTaskHeaderComponent, { set: { providers: [{ provide: WorkspaceTaskGitService, useValue: git }] } });
    const fixture = TestBed.createComponent(WorkspaceTaskHeaderComponent); fixture.detectChanges(); await fixture.whenStable();
    fixture.debugElement.query(By.directive(TaskHeaderComponent)).injector.get(TaskHeaderComponent).branchRename.emit('work');
    fixture.detectChanges(); await fixture.whenStable();
    const form = document.querySelector<HTMLFormElement>('form[aria-label="Rename branch"]');
    const field = form?.querySelector<HTMLInputElement>('input[aria-label="Branch name"]');
    const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(form).not.toBeNull(); expect(field).not.toBeNull(); expect(submit).not.toBeNull();
    expect(form?.querySelector<HTMLButtonElement>('button')?.type).toBe('button');
    if (!form || !field || !submit) throw new Error('The rename form is missing its native controls.');
    field.value = 'renamed'; field.dispatchEvent(new Event('input', { bubbles: true })); fixture.detectChanges();
    git.busy.set('rename-branch'); fixture.detectChanges();
    expect(submit.disabled).toBe(true);
    form.requestSubmit(submit); await fixture.whenStable();
    expect(git.perform).not.toHaveBeenCalled();
    git.busy.set(null); fixture.detectChanges();
    form.requestSubmit(submit); await fixture.whenStable();
    expect(git.perform).toHaveBeenCalledExactlyOnceWith({ type: 'rename-branch', branchName: 'renamed' });
    fixture.destroy();
  });
});

for (const uncommitted of [0, 2]) it(`checks authoritative work before ${uncommitted ? 'confirming a dirty task' : 'closing a clean task directly'}`, async () => {
  const store = {
    selected: signal({ scopeId: 'scope', taskId: 1, sessionId: 2 }), selectedTask: () => ({ id: 1, projectId: 3, name: 'Task', state: 'ready' }),
    projects: () => [], selectedTaskStage: () => 'active', busy: () => false, error: signal<string | null>(null), commitPanelAvailable: () => true, closeTask: vi.fn(async () => {}),
  };
  const bridge = { workspaceClosePreview: vi.fn(async () => ({ ok: true, value: { taskId: 1, sessions: 1, running: 0, unpushed: 0, uncommitted, terminals: 0, actions: 0 } })) };
  const git = { summary: () => undefined, commitPreview: () => null, state: () => undefined, loading: () => false, busy: () => null, error: () => null };
  TestBed.configureTestingModule({ providers: [{ provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
  TestBed.overrideComponent(WorkspaceTaskHeaderComponent, { set: { providers: [{ provide: WorkspaceTaskGitService, useValue: git }] } });
  const fixture = TestBed.createComponent(WorkspaceTaskHeaderComponent); fixture.detectChanges();
  fixture.debugElement.query(By.directive(TaskHeaderComponent)).injector.get(TaskHeaderComponent).closeRequested.emit();
  await fixture.whenStable(); fixture.detectChanges();
  expect(bridge.workspaceClosePreview).toHaveBeenCalledExactlyOnceWith('scope', 1);
  if (uncommitted) { expect(store.closeTask).not.toHaveBeenCalled(); expect(document.querySelector('[aria-label="Close task"]')).not.toBeNull(); }
  else expect(store.closeTask).toHaveBeenCalledExactlyOnceWith();
});
