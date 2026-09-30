import { ClaudeTaskState } from '@/shared/models/claude-runtime.model';
import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideListTodo, lucideX } from '@ng-icons/lucide';

interface Section {
  title: string;
  items: ClaudeTaskState[];
}

@Component({
  selector: 'cw-tasks-drawer',
  standalone: true,
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideX, lucideListTodo })],
  templateUrl: './claude-tasks-drawer.component.html',
  styleUrl: './claude-tasks-drawer.component.scss',
})
export class ClaudeTasksDrawerComponent {
  readonly open = input<boolean>(false);
  readonly tasks = input<ClaudeTaskState[]>([]);
  readonly close = output<void>();

  readonly sections = computed<Section[]>(() => {
    const tasks = [...this.tasks()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = tasks.filter((t) => t.status === 'running' || t.status === 'pending');
    const waiting = tasks.filter((t) => t.status === 'stopped');
    const done = tasks.filter((t) => !active.includes(t) && !waiting.includes(t)).slice(0, 10);
    return [
      { title: 'Active', items: active },
      { title: 'Waiting', items: waiting },
      { title: 'Recent', items: done },
    ].filter((s) => s.items.length);
  });

  statusTone(status: ClaudeTaskState['status']): string {
    if (status === 'running') return 'running';
    if (status === 'failed' || status === 'killed') return 'error';
    if (status === 'completed') return 'success';
    return 'waiting';
  }

  subtitle(task: ClaudeTaskState): string {
    const parts = [
      task.teamName,
      task.teammateName,
      task.taskType,
      task.workflowName,
      task.lastToolName ? `tool ${task.lastToolName}` : null,
    ].filter(Boolean);
    return parts.join(' · ');
  }
}
