import { Component, signal, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkspacesService } from '../../../shared/services/workspaces.service';
import { toast } from 'ngx-sonner';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { PendingWorkspaceCreationsService } from '@/shared/services/pending-workspace-creations.service';

@Component({
  selector: 'app-worktree-sheet',
  imports: [FormsModule, TrackNativeModalDirective, PathAutocompleteInputComponent],
  templateUrl: './worktree-sheet.html',
})
export class WorktreeSheet {
  private workspacesService = inject(WorkspacesService);
  private pendingWorkspaceCreations = inject(PendingWorkspaceCreationsService);

  @ViewChild('worktreeDialog') dialogRef!: TrackNativeModalDirective;

  repoId = signal(0);
  repoPath = signal('');
  repoName = signal('');
  workspaceName = signal('');
  branchName = signal('');
  worktreePath = signal('');
  creating = signal(false);
  autoCreateSession = signal(false);

  open(repoId: number, branchName: string, repoPath: string, repoName: string, autoCreateSession: boolean = false) {
    this.repoId.set(repoId);
    this.repoPath.set(repoPath);
    this.repoName.set(repoName);
    this.autoCreateSession.set(autoCreateSession);
    const parentDir = repoPath.substring(0, repoPath.lastIndexOf('/'));
    const selectedBranch = branchName || 'HEAD';
    const defaultName = selectedBranch === 'HEAD' ? 'Workspace' : selectedBranch;
    this.workspaceName.set(defaultName);
    this.branchName.set(selectedBranch);
    this.worktreePath.set(`${parentDir}/.worktrees/${repoName}/${this.slugify(defaultName)}`);
    this.dialogRef.open();
  }

  close() {
    this.dialogRef.close();
  }

  preferredWorktreeStartDirectory() {
    const repoPath = this.repoPath();
    if (!repoPath.includes('/')) {
      return undefined;
    }

    return repoPath.slice(0, repoPath.lastIndexOf('/'));
  }

  submit() {
    if (!this.workspaceName().trim() || !this.worktreePath().trim()) {
      return;
    }

    this.creating.set(true);
    this.workspacesService.create(this.repoId(), {
      name: this.workspaceName().trim(),
      path: this.worktreePath().trim(),
      startPoint: this.branchName().trim() || 'HEAD',
    }).subscribe({
      next: (job) => {
        this.pendingWorkspaceCreations.register(job, this.autoCreateSession());
        toast.success('Workspace creation started');
        this.creating.set(false);
        this.close();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not create workspace. ${msg}`);
        this.creating.set(false);
      },
    });
  }

  updatePathFromName() {
    const parentDir = this.repoPath().substring(0, this.repoPath().lastIndexOf('/'));
    this.worktreePath.set(`${parentDir}/.worktrees/${this.repoName()}/${this.slugify(this.workspaceName())}`);
  }

  private slugify(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  }
}
