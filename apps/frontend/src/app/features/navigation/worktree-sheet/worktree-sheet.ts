import { Component, signal, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorktreesService } from '../../../shared/services/worktrees.service';
import { PendingWorktreeCreationsService } from '../../../shared/services/pending-worktree-creations.service';
import { toast } from 'ngx-sonner';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';

@Component({
  selector: 'app-worktree-sheet',
  imports: [FormsModule, TrackNativeModalDirective, PathAutocompleteInputComponent],
  templateUrl: './worktree-sheet.html',
})
export class WorktreeSheet {
  private worktreesService = inject(WorktreesService);
  private pendingWorktreeCreations = inject(PendingWorktreeCreationsService);

  @ViewChild('worktreeDialog') dialogRef!: TrackNativeModalDirective;

  repoId = signal(0);
  branchName = signal('');
  repoPath = signal('');
  worktreePath = signal('');
  creating = signal(false);
  autoCreateSession = signal(false);

  open(repoId: number, branchName: string, repoPath: string, repoName: string, autoCreateSession: boolean = false) {
    this.repoId.set(repoId);
    this.branchName.set(branchName);
    this.repoPath.set(repoPath);
    this.autoCreateSession.set(autoCreateSession);
    const parentDir = repoPath.substring(0, repoPath.lastIndexOf('/'));
    this.worktreePath.set(`${parentDir}/.worktrees/${repoName}/${branchName}`);
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
    this.creating.set(true);
    this.worktreesService.create(this.repoId(), this.branchName(), this.worktreePath()).subscribe({
      next: (job) => {
        this.pendingWorktreeCreations.register(job, this.autoCreateSession());
        this.creating.set(false);
        this.close();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not create worktree. ${msg}`);
        this.creating.set(false);
      },
    });
  }
}
