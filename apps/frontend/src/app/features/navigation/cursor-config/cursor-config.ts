import { Component, signal, ViewChild, inject } from '@angular/core';
import { toast } from 'ngx-sonner';
import { CursorService } from '../../../shared/services/cursor.service';
import { SshForwardsService } from '../../../shared/services/ssh-forwards.service';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-cursor-config',
  imports: [TrackNativeModalDirective],
  templateUrl: './cursor-config.html',
})
export class CursorConfig {
  private cursorService = inject(CursorService);
  private sshForwardsService = inject(SshForwardsService);

  @ViewChild('cursorConfigDialog') dialogRef!: TrackNativeModalDirective;

  mode = signal<'local' | 'remote'>('local');
  sshHost = signal('');
  sshUser = signal('');
  private worktreePath = '';

  open(worktreePath: string) {
    this.worktreePath = worktreePath;

    // Pre-populate from existing settings or SSH forward defaults
    const existing = this.cursorService.getSettings();
    if (existing) {
      this.mode.set(existing.mode);
      this.sshHost.set(existing.sshHost ?? '');
      this.sshUser.set(existing.sshUser ?? '');
    } else {
      const defaults = this.sshForwardsService.getLastDefaults();
      if (defaults) {
        this.sshHost.set(defaults.sshHost ?? '');
        this.sshUser.set(defaults.sshUser ?? '');
      }
    }

    this.dialogRef.open();
  }

  close() {
    this.dialogRef.close();
  }

  async submit() {
    const settings = {
      mode: this.mode(),
      ...(this.mode() === 'remote' ? {
        sshHost: this.sshHost(),
        sshUser: this.sshUser() || undefined,
      } : {}),
    };

    this.cursorService.saveSettings(settings);

    const result = await this.cursorService.open(this.worktreePath);
    if (result.ok) {
      this.close();
    } else {
      toast.error(result.error || 'Could not open Cursor');
    }
  }
}
