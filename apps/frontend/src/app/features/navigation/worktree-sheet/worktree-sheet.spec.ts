import { Component, Directive, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { WorktreeSheet } from './worktree-sheet';
import { WorktreesService } from '../../../shared/services/worktrees.service';
import { PendingWorktreeCreationsService } from '../../../shared/services/pending-worktree-creations.service';

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
  const worktreesServiceMock = {
    create: vi.fn(),
  };
  const pendingWorktreeCreationsMock = {
    register: vi.fn(),
  };

  beforeEach(async () => {
    worktreesServiceMock.create.mockReset();
    pendingWorktreeCreationsMock.register.mockReset();

    TestBed.resetTestingModule();
    TestBed.overrideComponent(WorktreeSheet, {
      set: {
        imports: [MockTrackNativeModalDirective, MockPathAutocompleteInputComponent],
      },
    });

    await TestBed.configureTestingModule({
      imports: [WorktreeSheet],
      providers: [
        { provide: WorktreesService, useValue: worktreesServiceMock },
        { provide: PendingWorktreeCreationsService, useValue: pendingWorktreeCreationsMock },
      ],
    }).compileComponents();
  });

  it('registers the background job and closes immediately once the create request is accepted', () => {
    worktreesServiceMock.create.mockReturnValue(of({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }));

    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.repoId.set(7);
    component.branchName.set('feature');
    component.worktreePath.set('/tmp/repo/.worktrees/feature');
    component.autoCreateSession.set(true);

    component.submit();

    expect(pendingWorktreeCreationsMock.register).toHaveBeenCalledWith({
      jobId: 'job-1',
      repoId: 7,
      branchName: 'feature',
      worktreePath: '/tmp/repo/.worktrees/feature',
      status: 'pending',
    }, true);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(component.creating()).toBe(false);
  });

  it('prefills the default path with the repo name segment', () => {
    const fixture = TestBed.createComponent(WorktreeSheet);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const dialog = component.dialogRef as unknown as MockTrackNativeModalDirective;
    component.open(7, 'feature', '/tmp/repos/repo-one');

    expect(component.worktreePath()).toBe('/tmp/repos/.worktrees/repo-one/feature');
    expect(dialog.open).toHaveBeenCalledOnce();
  });
});
