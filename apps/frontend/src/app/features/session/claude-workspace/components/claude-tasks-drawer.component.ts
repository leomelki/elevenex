import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucideListTodo } from '@ng-icons/lucide';
import { ClaudeTaskState } from '@/shared/models/claude-runtime.model';

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
  template: `
    @if (open()) {
      <div class="cw-drawer__backdrop" (click)="close.emit()"></div>
      <aside class="cw-drawer">
        <header class="cw-drawer__head">
          <h3>
            <ng-icon name="lucideListTodo" size="14" />
            Tasks
          </h3>
          <button type="button" class="cw-drawer__close" (click)="close.emit()">
            <ng-icon name="lucideX" size="14" />
          </button>
        </header>

        <div class="cw-drawer__body">
          @if (!tasks().length) {
            <p class="cw-drawer__empty">No tasks yet. They appear here as Claude runs tools or subagents.</p>
          }
          @for (section of sections(); track section.title) {
            <section class="cw-drawer__sec">
              <h4>{{ section.title }} <span>({{ section.items.length }})</span></h4>
              @for (task of section.items; track task.taskId) {
                <div class="cw-drawer__task" [attr.data-tone]="statusTone(task.status)">
                  <div class="cw-drawer__task-head">
                    <strong>{{ task.subject || task.summary || task.description || task.taskType || task.taskId }}</strong>
                    <span class="cw-drawer__status">{{ task.status }}</span>
                  </div>
                  @if (subtitle(task); as s) {
                    <p>{{ s }}</p>
                  }
                  @if (task.error) {
                    <pre class="cw-drawer__err">{{ task.error }}</pre>
                  }
                </div>
              }
            </section>
          }
        </div>
      </aside>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .cw-drawer__backdrop {
        position: fixed;
        inset: 0;
        background: color-mix(in oklab, #000 30%, transparent);
        z-index: 40;
      }
      .cw-drawer {
        position: fixed;
        top: 0;
        right: 0;
        height: 100dvh;
        width: min(26rem, 92vw);
        background: var(--background);
        border-left: 1px solid var(--border);
        z-index: 41;
        display: flex;
        flex-direction: column;
        box-shadow: -10px 0 30px -10px color-mix(in oklab, #000 25%, transparent);
      }
      .cw-drawer__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.75rem 0.875rem;
        border-bottom: 1px solid var(--border);
      }
      .cw-drawer__head h3 {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.875rem;
        font-weight: 600;
        margin: 0;
      }
      .cw-drawer__close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.5rem;
        height: 1.5rem;
        border: 0;
        background: transparent;
        border-radius: 0.25rem;
        cursor: pointer;
        color: var(--muted-foreground);
      }
      .cw-drawer__close:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--foreground);
      }
      .cw-drawer__body {
        flex: 1;
        overflow: auto;
        padding: 0.625rem 0.875rem 1rem;
      }
      .cw-drawer__empty {
        font-size: 0.8125rem;
        color: var(--muted-foreground);
      }
      .cw-drawer__sec {
        margin-top: 0.75rem;
      }
      .cw-drawer__sec h4 {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted-foreground);
        margin: 0 0 0.375rem;
      }
      .cw-drawer__sec h4 span {
        font-weight: 400;
        opacity: 0.7;
      }
      .cw-drawer__task {
        padding: 0.5rem 0.625rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        margin-bottom: 0.375rem;
        font-size: 0.8125rem;
      }
      .cw-drawer__task[data-tone='running'] {
        border-color: color-mix(in oklab, var(--primary) 40%, var(--border));
      }
      .cw-drawer__task[data-tone='error'] {
        border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
      }
      .cw-drawer__task-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.5rem;
      }
      .cw-drawer__status {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-foreground);
      }
      .cw-drawer__task p {
        margin: 0.25rem 0 0;
        color: var(--muted-foreground);
        font-size: 0.75rem;
      }
      .cw-drawer__err {
        margin: 0.375rem 0 0;
        padding: 0.375rem 0.5rem;
        background: color-mix(in oklab, var(--destructive) 10%, transparent);
        color: var(--destructive);
        border-radius: 0.25rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.6875rem;
        max-height: 10rem;
        overflow: auto;
        white-space: pre-wrap;
      }
    `,
  ],
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
