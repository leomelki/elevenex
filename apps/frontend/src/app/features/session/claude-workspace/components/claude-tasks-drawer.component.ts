import { ZardButtonComponent } from '@/shared/components/button';
import type { AgentSubagentState } from '@/shared/models/agent-runtime.model';
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
  imports: [ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './claude-tasks-drawer.component.html',
  host: { class: 'contents' },
})
export class ClaudeTasksDrawerComponent {
  readonly open = input<boolean>(false);
  readonly tasks = input<readonly ClaudeTaskState[]>([]);
  readonly agents = input<readonly AgentSubagentState[]>([]);
  readonly readOnly = input(false);
  readonly busyActions = input<Record<string, string>>({});
  readonly inspectAgent = output<string>();
  readonly stopTask = output<string>();
  readonly close = output<void>();
  readonly agentIds = computed(
    () => new Set(this.agents().map((agent) => agent.taskId ?? agent.agentId)),
  );

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
          zTitle: 'Session tasks',
          zAriaLabel: 'Session tasks',
          zCloseLabel: 'Close session tasks',
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
    const tasks = this.tasks()
      .filter((task) => !task.ambient && !task.skipTranscript)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = tasks.filter((t) => t.status === 'running' || t.status === 'pending');
    const waiting = tasks.filter((t) => t.status === 'paused');
    const done = tasks.filter((t) => !active.includes(t) && !waiting.includes(t)).slice(0, 10);
    return [
      { title: 'Active', items: active },
      { title: 'Waiting', items: waiting },
      { title: 'Recent', items: done },
    ].filter((s) => s.items.length);
  });

  statusTone(status: ClaudeTaskState['status']): string {
    if (status === 'running') return 'running';
    if (status === 'failed') return 'error';
    if (status === 'completed') return 'success';
    if (status === 'stopped' || status === 'killed' || status === 'unavailable') return 'muted';
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
