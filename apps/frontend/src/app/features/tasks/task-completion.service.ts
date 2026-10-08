import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { NavigationService } from '@/shared/services/navigation.service';
import { TabService } from '@/features/session/tab-service';
import { VSCodeWebStateService } from '@/features/vscode-web/vscode-web-state.service';
import { Task, taskError } from './task.model';
import { TasksApiService } from './tasks-api.service';
import { TaskOperationsService } from './task-operations.service';

@Injectable({ providedIn: 'root' })
export class TaskCompletionService {
  private readonly api = inject(TasksApiService);
  private readonly tabs = inject(TabService);
  private readonly navigation = inject(NavigationService);
  private readonly editors = inject(VSCodeWebStateService);
  private readonly operations = inject(TaskOperationsService);
  private readonly router = inject(Router);
  async finish(task: Task, confirmStop: boolean) {
    const finished = await firstValueFrom(this.api.finish(task.id, confirmStop));
    const ids = new Set(finished.sessions.map((session) => session.id));
    const wasActive = ids.has(this.tabs.activeSessionId() ?? -1);
    for (const tab of [...this.tabs.tabs()])
      if (ids.has(tab.sessionId) || tab.workspaceId === task.id) this.tabs.closeTab(tab.sessionId);
    this.editors.destroyForPath(task.path);
    this.navigation.refreshTree();
    if (wasActive || this.router.url.startsWith(`/tasks/${task.id}`))
      await this.router.navigate(['/tasks', task.id], {
        queryParams: { finished: finished.archivedAt },
        replaceUrl: true,
      });
    toast.success('Task finished', {
      description: task.name,
      action: {
        label: 'Undo',
        onClick: () => void this.reopen(task.id).catch((error) => toast.error(taskError(error))),
      },
    });
    return finished;
  }
  async reopen(id: number) {
    const task = await firstValueFrom(this.api.reopen(id));
    this.operations.track(task);
    await this.router.navigate(['/tasks', id]);
  }
}
