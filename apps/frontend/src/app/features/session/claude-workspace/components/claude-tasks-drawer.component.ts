import { ClaudeTaskState } from '@/shared/models/claude-runtime.model';
import { ZardSheetService, ZardSheetRef } from '@/shared/components/sheet';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  TemplateRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

interface Section {
  title: string;
  items: ClaudeTaskState[];
}

@Component({
  selector: 'cw-tasks-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-tasks-drawer.component.html',
  host: { class: 'contents' },
})
export class ClaudeTasksDrawerComponent {
  readonly open = input<boolean>(false);
  readonly tasks = input<readonly ClaudeTaskState[]>([]);
  readonly close = output<void>();

  private readonly sheets = inject(ZardSheetService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly content = viewChild<TemplateRef<unknown>>('content');
  private sheet: ZardSheetRef<unknown> | null = null;

  constructor() {
    effect(() => {
      const content = this.content();
      if (this.open() && content && !this.sheet) {
        const sheet = this.sheets.create<unknown, undefined>({
          zContent: content,
          zViewContainerRef: this.viewContainer,
          zTitle: 'Agent steps',
          zAriaLabel: 'Agent steps',
          zCloseLabel: 'Close agent steps',
          zSide: 'right',
          zSize: 'custom',
          zHideFooter: true,
          zCustomClasses:
            'cw-drawer h-dvh w-[min(26rem,92vw)] gap-0 overflow-hidden text-foreground [&>header]:border-b [&>header]:border-border [&>main]:min-h-0 [&>main]:flex-1 [&>main]:overflow-auto',
        });
        this.sheet = sheet;
        sheet
          .afterClosed()
          .pipe(takeUntilDestroyed(this.destroyRef))
          .subscribe(() => {
            if (this.sheet !== sheet) return;
            this.sheet = null;
            this.close.emit();
          });
      } else if (!this.open()) this.dismissSheet();
    });
    this.destroyRef.onDestroy(() => this.dismissSheet());
  }

  private dismissSheet(): void {
    const sheet = this.sheet;
    this.sheet = null;
    sheet?.close();
  }

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
