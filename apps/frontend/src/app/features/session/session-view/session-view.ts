import { Component, inject, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon } from '@ng-icons/core';
import { lucideGitFork, lucideSquare } from '@ng-icons/lucide';
import { SessionsService } from '../../../shared/services/sessions.service';
import { NavigationService } from '../../../shared/services/navigation.service';
import { Session } from '../../../shared/models/session.model';
import { ClaudeTerminalComponent } from '../terminal';
import { toast } from 'ngx-sonner';
import { Subject, takeUntil } from 'rxjs';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-session-view',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, ClaudeTerminalComponent, TrackNativeModalDirective],
  templateUrl: './session-view.html',
})
export class SessionView implements OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sessionsService = inject(SessionsService);
  private navService = inject(NavigationService);
  private destroy$ = new Subject<void>();

  readonly lucideGitFork = lucideGitFork;
  readonly lucideSquare = lucideSquare;

  session = signal<Session | null>(null);
  loading = signal(true);
  sessionId = signal<number | null>(null);
  showKillDialog = signal(false);
  showForkDialog = signal(false);
  forkName = signal('');

  constructor() {
    // Subscribe to route params to handle navigation between sessions
    this.route.paramMap
      .pipe(takeUntil(this.destroy$))
      .subscribe(params => {
        const id = Number(params.get('id'));
        if (id && id !== this.sessionId()) {
          this.sessionId.set(id);
          this.loadSession(id);
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadSession(id: number): void {
    this.loading.set(true);
    this.sessionsService.getOne(id).subscribe({
      next: (s) => {
        this.session.set(s);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Failed to load session:', err);
        toast.error('Failed to load session');
        this.loading.set(false);
      },
    });
  }

  archiveSession(): void {
    const s = this.session();
    if (!s) return;

    this.sessionsService.archive(s.id).subscribe({
      next: () => {
        toast.success('Session archived');
        this.navService.refreshTree();
        this.router.navigate(['/projects']);
      },
      error: (err) => {
        console.error('Failed to archive session:', err);
        toast.error('Failed to archive session');
      },
    });
  }

  resetSession(): void {
    const s = this.session();
    if (!s) return;

    this.sessionsService.reset(s.id).subscribe({
      next: (newSession) => {
        toast.success('Session reset');
        this.navService.refreshTree();
        this.router.navigate(['/sessions', newSession.id]);
      },
      error: (err) => {
        console.error('Failed to reset session:', err);
        toast.error('Failed to reset session');
      },
    });
  }

  forkSession(): void {
    const s = this.session();
    if (!s) return;

    this.sessionsService.fork(s.id, this.forkName() || undefined).subscribe({
      next: (newSession) => {
        toast.success('Session forked');
        this.navService.refreshTree();
        this.showForkDialog.set(false);
        this.forkName.set('');
        // Navigate to new session
        this.router.navigate(['/sessions', newSession.id]);
      },
      error: (err) => {
        console.error('Failed to fork session:', err);
        toast.error('Could not fork session. ' + (err.error?.message || ''));
      },
    });
  }

  killSession(): void {
    const s = this.session();
    if (!s) return;

    this.sessionsService.kill(s.id).subscribe({
      next: () => {
        toast.success('Session stopped');
        this.navService.refreshTree();
        this.showKillDialog.set(false);
        // Update local session status
        this.session.update(sess => sess ? { ...sess, status: 'stopped' } : null);
      },
      error: (err) => {
        console.error('Failed to kill session:', err);
        toast.error('Could not stop session. ' + (err.error?.message || ''));
      },
    });
  }
}
