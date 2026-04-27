import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucidePencil,
  lucidePlay,
  lucidePlus,
  lucideSquare,
  lucideTerminal,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { firstValueFrom } from 'rxjs';
import { Action } from '@/shared/models/action.model';
import { ActionsApiService } from '@/shared/services/actions-api.service';
import { ActionTerminalViewComponent } from './action-terminal-view.component';
import { ActionsStateService } from './actions-state.service';

@Component({
  selector: 'app-actions-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, ActionTerminalViewComponent],
  templateUrl: './actions-panel.component.html',
  styleUrls: ['./actions-panel.component.scss'],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucidePencil,
      lucidePlay,
      lucidePlus,
      lucideSquare,
      lucideTerminal,
      lucideTrash2,
      lucideX,
    }),
  ],
})
export class ActionsPanelComponent {
  worktreePath = input.required<string>();
  close = output<void>();

  private readonly state = inject(ActionsStateService);
  private readonly api = inject(ActionsApiService);
  private readonly destroyRef = inject(DestroyRef);

  actions = computed(() => this.state.getActions(this.worktreePath()));
  selectedActionId = computed(() => this.state.getSelectedActionId(this.worktreePath()));
  selectedAction = computed(() =>
    this.actions().find(action => action.id === this.selectedActionId()) ?? null,
  );
  runningCount = computed(() => this.state.getRunningCount(this.worktreePath()));

  showCreateForm = signal(false);
  isEditing = signal(false);
  readonly timeTick = signal(Date.now());

  private readonly worktreeEffect = effect(() => {
    const worktreePath = this.worktreePath();
    if (worktreePath) {
      void this.state.loadActions(worktreePath);
    }
  });

  constructor() {
    const intervalId = window.setInterval(() => {
      this.timeTick.set(Date.now());
    }, 60_000);

    this.destroyRef.onDestroy(() => {
      window.clearInterval(intervalId);
    });
  }

  async createAction(name: string, command: string): Promise<void> {
    const worktreePath = this.worktreePath();
    if (!worktreePath || !name.trim() || !command.trim()) return;

    try {
      const action = await firstValueFrom(this.api.create(worktreePath, name, command));
      this.state.upsertAction(worktreePath, action);
      this.state.setSelectedAction(worktreePath, action.id);
      toast.success(`Action "${action.name}" created`);
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not create action');
    }
  }

  selectAction(actionId: number): void {
    this.state.setSelectedAction(this.worktreePath(), actionId);
  }

  async saveAction(action: Action, name: string, command: string): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.update(action.id, { name, command }));
      this.state.upsertAction(this.worktreePath(), updated);
      toast.success(`Updated "${updated.name}"`);
    } catch (error: any) {
      toast.error(error?.error?.message || `Could not update "${action.name}"`);
    }
  }

  async runAction(action: Action): Promise<void> {
    try {
      const updated = await firstValueFrom(this.api.run(action.id));
      this.state.upsertAction(this.worktreePath(), updated);
      this.state.setSelectedAction(this.worktreePath(), action.id);
      toast.success(`Running "${action.name}"`);
    } catch (error: any) {
      toast.error(error?.error?.message || `Could not run "${action.name}"`);
    }
  }

  async stopAction(action: Action): Promise<void> {
    try {
      await firstValueFrom(this.api.stop(action.id));
      this.state.updateActionStatus(this.worktreePath(), action.id, 'stopped');
      toast.success(`Stopping "${action.name}"`);
    } catch (error: any) {
      toast.error(error?.error?.message || `Could not stop "${action.name}"`);
    }
  }

  async removeAction(action: Action): Promise<void> {
    try {
      await firstValueFrom(this.api.remove(action.id));
      this.state.removeAction(this.worktreePath(), action.id);
      toast.success(`Deleted "${action.name}"`);
    } catch (error: any) {
      toast.error(error?.error?.message || `Could not delete "${action.name}"`);
    }
  }

  toggleCreateForm(): void {
    this.showCreateForm.update(v => !v);
  }

  startEditing(): void {
    this.isEditing.set(true);
  }

  stopEditing(): void {
    this.isEditing.set(false);
  }

  statusTone(action: Action): string {
    switch (action.status) {
      case 'running':
        return 'running';
      case 'success':
        return 'success';
      case 'failed':
        return 'failed';
      case 'stopped':
        return 'stopped';
      default:
        return 'idle';
    }
  }

  outputFor(action: Action | null): string {
    if (!action) return '';
    return action.status === 'running'
      ? (action.currentOutput || action.lastOutput)
      : action.lastOutput;
  }

  lastTriggeredLabel(action: Action): string | null {
    this.timeTick();

    if (!action.lastRunAt) {
      return null;
    }

    const timestamp = new Date(action.lastRunAt).getTime();
    if (Number.isNaN(timestamp)) {
      return null;
    }

    const diffMs = Math.max(0, Date.now() - timestamp);
    const diffMinutes = Math.floor(diffMs / 60_000);

    if (diffMinutes < 1) {
      return 'now';
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}h`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}d`;
    }

    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 5) {
      return `${diffWeeks}w`;
    }

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) {
      return `${diffMonths}mo`;
    }

    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y`;
  }

  lastTriggeredTooltip(action: Action): string {
    if (!action.lastRunAt) {
      return 'Never triggered';
    }

    const date = new Date(action.lastRunAt);
    if (Number.isNaN(date.getTime())) {
      return 'Last triggered';
    }

    return `Last triggered ${date.toLocaleString()}`;
  }

  async handleActionStatus(status: Action['status']): Promise<void> {
    const selected = this.selectedAction();
    if (!selected) return;

    this.state.updateActionStatus(this.worktreePath(), selected.id, status);

    if (status !== 'running') {
      await this.state.loadActions(this.worktreePath());
    }
  }
}
