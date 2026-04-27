import { Component, inject, input, output, signal, viewChild, OnInit, computed, effect, untracked } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucidePlus, lucideTrash2, lucideCheck, lucideChevronDown, lucideGripVertical } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { TodosService, Todo } from '../todos.service';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-todo-panel',
  imports: [
    CommonModule,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    DragDropModule,
    TrackNativeModalDirective,
  ],
  templateUrl: './todo-panel.html',
  styleUrl: './todo-panel.scss',
  viewProviders: [provideIcons({ lucideX, lucidePlus, lucideTrash2, lucideCheck, lucideChevronDown, lucideGripVertical })],
})
export class TodoPanelComponent implements OnInit {
  projectId = input.required<number>();
  isOpen = input<boolean>(false);
  close = output<void>();

  private todosService = inject(TodosService);

  todos = signal<Todo[]>([]);
  loading = signal(true);
  newTodoText = signal('');
  editingTodoId = signal<number | null>(null);
  editText = signal('');
  showCompleted = signal(true);

  showClearDialog = signal(false);
  private clearDialogRef = viewChild<TrackNativeModalDirective>('clearDialog');

  pendingTodos = computed(() => 
    this.todos()
      .filter(t => !t.completed)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  );

  completedTodos = computed(() => 
    this.todos()
      .filter(t => t.completed)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  );

  remainingCount = computed(() => this.pendingTodos().length);

  constructor() {
    // Watch for projectId changes and reload
    effect(() => {
      const pid = this.projectId();
      if (pid) {
        this.loadTodos();
      }
    });

    // Sync pending count back to the service for the badge
    effect(() => {
      const count = this.remainingCount();
      const pid = this.projectId();
      if (pid) {
        untracked(() => this.todosService.setPendingCount(pid, count));
      }
    });
  }

  ngOnInit() {
    this.loadTodos();
  }

  loadTodos() {
    this.loading.set(true);
    this.todosService.getTodos(this.projectId()).subscribe({
      next: (todos) => {
        this.todos.set(todos);
        this.loading.set(false);
      },
      error: () => {
        toast.error('Could not load tasks');
        this.loading.set(false);
      },
    });
  }

  addTodo() {
    const text = this.newTodoText().trim();
    if (!text) return;

    this.todosService.createTodo(this.projectId(), text).subscribe({
      next: (todo) => {
        this.todos.update(list => [...list, todo]);
        this.newTodoText.set('');
        toast.success('Task added');
      },
      error: () => {
        toast.error('Could not add task');
      },
    });
  }

  onNewTodoKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      this.addTodo();
    }
  }

  toggleComplete(todo: Todo) {
    this.todosService.updateTodo(todo.id, { completed: !todo.completed }).subscribe({
      next: (updated) => {
        this.todos.update(list => 
          list.map(t => t.id === todo.id ? updated : t)
        );
      },
      error: () => {
        toast.error('Could not update task');
      },
    });
  }

  startEdit(todo: Todo) {
    this.editingTodoId.set(todo.id);
    this.editText.set(todo.text);
  }

  cancelEdit() {
    this.editingTodoId.set(null);
    this.editText.set('');
  }

  saveEdit(todoId: number) {
    const text = this.editText().trim();
    if (!text) {
      this.deleteTodo(todoId);
      return;
    }

    this.todosService.updateTodo(todoId, { text }).subscribe({
      next: (updated) => {
        this.todos.update(list => 
          list.map(t => t.id === todoId ? updated : t)
        );
        this.editingTodoId.set(null);
        this.editText.set('');
      },
      error: () => {
        toast.error('Could not update task');
      },
    });
  }

  onEditKeydown(event: KeyboardEvent, todoId: number) {
    if (event.key === 'Enter') {
      this.saveEdit(todoId);
    } else if (event.key === 'Escape') {
      this.cancelEdit();
    }
  }

  deleteTodo(todoId: number) {
    this.todosService.deleteTodo(todoId).subscribe({
      next: () => {
        this.todos.update(list => list.filter(t => t.id !== todoId));
        toast.success('Task deleted');
      },
      error: () => {
        toast.error('Could not delete task');
      },
    });
  }

  openClearDialog() {
    this.showClearDialog.set(true);
    setTimeout(() => this.clearDialogRef()?.open());
  }

  closeClearDialog() {
    this.clearDialogRef()?.close();
    this.showClearDialog.set(false);
  }

  clearCompleted() {
    this.todosService.clearCompleted(this.projectId()).subscribe({
      next: ({ count }) => {
        this.todos.update(list => list.filter(t => !t.completed));
        toast.success(`${count} completed task${count !== 1 ? 's' : ''} cleared`);
        this.closeClearDialog();
      },
      error: () => {
        toast.error('Could not clear completed tasks');
      },
    });
  }

  toggleShowCompleted() {
    this.showCompleted.update(v => !v);
  }

  onClose() {
    this.close.emit();
  }

  onDrop(event: CdkDragDrop<Todo[]>) {
    const items = [...this.pendingTodos()];
    moveItemInArray(items, event.previousIndex, event.currentIndex);

    const updates = items.map((item, index) => ({
      id: item.id,
      sortOrder: index
    }));

    this.todosService.updateOrders(this.projectId(), updates).subscribe({
      next: () => this.loadTodos(),
      error: () => toast.error('Could not reorder tasks')
    });
  }
}
