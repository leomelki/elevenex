import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

const NEVER_SHOW_KEY = 'plannotator-install-never-show';

@Injectable({ providedIn: 'root' })
export class PlannotatorInstallPromptService {
  private readonly http = inject(HttpClient);
  private readonly _show = signal(false);
  readonly show = this._show.asReadonly();

  async initialize(): Promise<void> {
    if (localStorage.getItem(NEVER_SHOW_KEY) === 'true') {
      return;
    }
    try {
      const result = await firstValueFrom(
        this.http.get<{ installed: boolean }>('/api/plannotator/installed'),
      );
      if (!result.installed) {
        this._show.set(true);
      }
    } catch {
      // silently ignore — don't block startup
    }
  }

  dismiss(): void {
    this._show.set(false);
  }

  neverShowAgain(): void {
    localStorage.setItem(NEVER_SHOW_KEY, 'true');
    this._show.set(false);
  }
}
