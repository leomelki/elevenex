import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TasksApiService } from './tasks-api.service';

/** Keep saves ordered and alive when the preparation page is closed. */
@Injectable({ providedIn: 'root' })
export class TaskDraftService {
  private readonly api = inject(TasksApiService);
  private readonly pending = new Map<number, Promise<unknown>>();

  save(id: number, text: string): Promise<unknown> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const save = previous
      .catch(() => undefined)
      .then(() => firstValueFrom(this.api.draft(id, text)));
    this.pending.set(id, save);
    const release = () => {
      if (this.pending.get(id) === save) this.pending.delete(id);
    };
    void save.then(release, release);
    return save;
  }
}
