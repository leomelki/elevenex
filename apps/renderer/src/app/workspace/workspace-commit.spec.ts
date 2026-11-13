import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommitPanelComponent, TaskHeaderComponent, type CommitIntent } from '../tasks';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskHeaderComponent } from './workspace-task-header.component';
import { WorkspaceTaskGitService } from './workspace-task-git.service';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

it('keeps failed commits open, retains their provider across session changes, and closes only after success', async () => {
  const selected = signal({ scopeId: 'scope', taskId: 1, sessionId: 2 });
  const store = { taskSelection: selected, selectedCreation: () => null, offline: () => false, selected, selectedTask: () => ({ id: 1, name: 'Task', state: 'ready' }), projects: () => [], selectedTaskStage: () => 'active', busy: () => false, commitPanelAvailable: () => true };
  const error = signal<string | null>(null), busy = signal<string | null>(null);
  let complete!: (saved: boolean) => void;
  const git = {
    summary: () => ({ branch: 'work' }), commitPreview: () => null, state: () => ({ files: 1, add: 1, del: 0, ahead: 0 }),
    error, busy, uncertain: () => false, loading: () => false,
    readCommitPreview: vi.fn(async () => ({ revision: 'checked', items: [], nextCursor: null, total: 1, matches: 1, unstaged: 1, selected: { files: 1, add: 1, del: 0, staged: 0, unstaged: 1 }, running: [] })),
    perform: vi.fn(() => { busy.set('commit'); return new Promise<boolean>(resolve => { complete = saved => { error.set(saved ? null : 'Write a message and try again.'); busy.set(null); resolve(saved); }; }); }),
  };
  TestBed.configureTestingModule({ providers: [{ provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: {} }] });
  TestBed.overrideComponent(WorkspaceTaskHeaderComponent, { set: { providers: [{ provide: WorkspaceTaskGitService, useValue: git }] } });
  const fixture = TestBed.createComponent(WorkspaceTaskHeaderComponent); fixture.detectChanges();
  const header = fixture.debugElement.query(By.directive(TaskHeaderComponent)).componentInstance as TaskHeaderComponent;
  const panel = fixture.debugElement.query(By.directive(CommitPanelComponent)).componentInstance as CommitPanelComponent;
  header.gitAction.emit('commit'); fixture.detectChanges();
  const provider = panel.fileProvider();
  const intent: CommitIntent = { message: 'My message', files: ['work.txt'], push: false, selection: { includeUnstaged: true, excluded: [], includedSecrets: [] }, revision: 'checked' };
  panel.commitRequested.emit(intent); fixture.detectChanges();
  expect(panel.open()).toBe(true); expect(panel.busy()).toBe(true);
  selected.set({ scopeId: 'scope', taskId: 1, sessionId: 3 }); fixture.detectChanges();
  expect(panel.fileProvider()).toBe(provider); expect(panel.open()).toBe(true);
  complete(false); await Promise.resolve(); fixture.detectChanges();
  expect(panel.open()).toBe(true); expect(panel.submissionError()).toContain('Write a message');
  panel.commitRequested.emit(intent); complete(true); await Promise.resolve(); fixture.detectChanges();
  expect(panel.open()).toBe(false); expect(git.perform).toHaveBeenCalledTimes(2);
});
