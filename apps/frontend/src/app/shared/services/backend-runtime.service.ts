import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface BackendRuntimeStatus {
  /** False when the backend was started without a launcher that can relaunch it. */
  restartSupported: boolean;
  restarting: boolean;
  pid: number;
  startedAt: string;
}

@Injectable({ providedIn: 'root' })
export class BackendRuntimeService {
  private readonly http = inject(HttpClient);

  getStatus(): Promise<BackendRuntimeStatus> {
    return firstValueFrom(this.http.get<BackendRuntimeStatus>('/api/runtime'));
  }

  /**
   * Asks the backend to exit so its launcher starts it again. The response
   * arrives before the process goes away; the socket drop that follows is what
   * tells the app the restart is underway.
   */
  restart(): Promise<BackendRuntimeStatus> {
    return firstValueFrom(
      this.http.post<BackendRuntimeStatus>('/api/runtime/restart', {}),
    );
  }
}
