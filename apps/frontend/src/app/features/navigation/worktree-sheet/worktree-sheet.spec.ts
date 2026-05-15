import { Component, Directive, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { WorktreeSheet } from './worktree-sheet';
import { WorkspacesService } from '../../../shared/services/workspaces.service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { NavigationService } from '../../../shared/services/navigation.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

@Directive({
  selector: 'dialog[trackNativeModal]',
  standalone: true,
  exportAs: 'trackedNativeModal',
})
class MockTrackNativeModalDirective {
  close = vi.fn();
  open = vi.fn();
}

@Component({
  selector: 'app-path-autocomplete-input',
  standalone: true,
  template: '',
})
class MockPathAutocompleteInputComponent {
  readonly value = input('');
  readonly preferredStartDirectory = input<string | undefined>(undefined);
  readonly pathKind = input<'file' | 'directory' | 'either'>('either');
  readonly placeholder = input('');
  readonly valueChange = output<string>();
}

describe('WorktreeSheet', () => {
  const workspacesServiceMock = {
    create: vi.fn(),
  };
  const sessionsServiceMock = {
    create: vi.fn(),
  };
  const navigationServiceMock = {
    refreshTree: vi.fn(),
    openSession: vi.fn(),
  };

  beforeEach(async () => {
    workspacesServiceMock.create.mockReset();
    sessionsServiceMock.create.mockReset();
    navigationServiceMock.refreshTree.mockReset();
    navigationServiceMock.openSession.mockReset();

    TestBed.resetTestingModule();
    TestBed.overrideComponent(WorktreeSheet, {
      set: {
        imports: [FormsModule, MockTrackNativeModalDirective, MockPathAutocompleteInputComponent],
      },
    });

    await TestBed.configureTestingModule({
      imports: [WorktreeSheet],
      providers: [
        { provide: WorkspacesService, useValue: workspacesServiceMock },
        { provide: SessionsService, useValue: sessionsServiceMock },
        { provide: NavigationService, useValue: navigationServiceMock },
      ],
    }).compileComponents();
  });

  it('creates a workspace from the selected branch and opens an auto-created session', () => {
    workspacesServiceMock.create.mockReturnValue(of({
      id: 99,
      repoId: 7,
      name: 'feature',
      path: '/tmp/repo/.worktrees/feature',
    }));
    sessionsServiceMock.create.mockReturnValue(of({ id: 123 }));

    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.repoId.set(7);
    component.branchName.set('feature');
    component.workspaceName.set('feature');
    component.worktreePath.set('/tmp/repo/.worktrees/feature');
    component.autoCreateSession.set(true);

    component.submit();

    expect(workspacesServiceMock.create).toHaveBeenCalledWith(7, {
      name: 'feature',
      path: '/tmp/repo/.worktrees/feature',
      startPoint: 'feature',
    });
    expect(sessionsServiceMock.create).toHaveBeenCalledWith({ repoId: 7, workspaceId: 99 });
    expect(navigationServiceMock.refreshTree).toHaveBeenCalledOnce();
    expect(navigationServiceMock.openSession).toHaveBeenCalledWith(123);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(component.creating()).toBe(false);
  });

  it('prefills the default path with the supplied repo name segment', () => {
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.open(7, 'feature', '/tmp/repos/path-basename', 'repo-one');

    expect(component.worktreePath()).toBe('/tmp/repos/.worktrees/repo-one/feature');
    expect(dialog.open).toHaveBeenCalledOnce();
  });
});
