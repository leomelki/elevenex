import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface ToolTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  activeForm?: string;
}

@Component({
  selector: 'cw-tool-todos',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .cw-todos {
      list-style: none;
      padding: 0 0.625rem 0.5rem;
      margin: 0;
      display: grid;
      gap: 0.25rem;
    }
    .cw-todos li {
      display: grid;
      grid-template-columns: 1rem 1fr;
      gap: 0.45rem;
      align-items: start;
      color: var(--muted-foreground);
      font-size: 0.8125rem;
      line-height: 1.45;
    }
    .cw-todos li[data-status='completed'] {
      color: color-mix(in oklab, var(--muted-foreground) 75%, transparent);
    }
    .cw-todos li[data-status='in_progress'] {
      color: var(--foreground);
    }
    .cw-todos__box {
      width: 0.75rem;
      height: 0.75rem;
      margin-top: 0.18rem;
      border: 1px solid var(--border);
      border-radius: 0.1875rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.625rem;
      line-height: 1;
      color: var(--background);
      flex-shrink: 0;
    }
    .cw-todos__box--done {
      background: color-mix(in oklab, #16a34a 90%, var(--primary));
      border-color: transparent;
    }
    .cw-todos__box--active {
      border-color: var(--primary);
      background: color-mix(in oklab, var(--primary) 18%, transparent);
    }
    .cw-todos__text {
      min-width: 0;
    }
  `],
  template: `
    <ul class="cw-todos">
      @for (todo of todos(); track $index) {
        <li [attr.data-status]="todo.status">
          @switch (todo.status) {
            @case ('completed') { <span class="cw-todos__box cw-todos__box--done">✓</span> }
            @case ('in_progress') { <span class="cw-todos__box cw-todos__box--active"></span> }
            @default { <span class="cw-todos__box"></span> }
          }
          <span class="cw-todos__text">
            {{ todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content }}
          </span>
        </li>
      }
    </ul>
  `,
})
export class ToolTodosComponent {
  readonly todos = input.required<ToolTodoItem[]>();
}
