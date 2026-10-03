import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

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
  styleUrl: './tool-todos.component.scss',
  template: `
    <ul class="cw-todos">
      @for (todo of todos(); track $index) {
        <li [attr.data-status]="todo.status">
          @switch (todo.status) {
            @case ('completed') {
              <span class="cw-todos__box cw-todos__box--done">✓</span>
            }
            @case ('in_progress') {
              <span class="cw-todos__box cw-todos__box--active"></span>
            }
            @default {
              <span class="cw-todos__box"></span>
            }
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
