import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideMonitor,
  lucideSettings,
  lucideSquareTerminal,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { DefaultClaudeSessionSurface } from '@/shared/models/app-settings.model';
import { ZardButtonComponent } from '@/shared/components/button';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { FRONTEND_GIT_SHA } from '../../../build-info';

@Component({
  selector: 'app-settings',
  imports: [NgIcon, ZardButtonComponent],
  templateUrl: './settings.html',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideMonitor,
      lucideSettings,
      lucideSquareTerminal,
    }),
  ],
})
export class Settings {
  private readonly http = inject(HttpClient);
  private readonly externalLinks = getElectronExternalLinksApi();
  readonly appSettings = inject(AppSettingsService);

  readonly frontendSha = FRONTEND_GIT_SHA.slice(0, 7);
  readonly backendSha = signal('...');

  constructor() {
    void this.appSettings.load().catch(() => undefined);
    this.http.get<{ backendSha: string }>('/api/info').subscribe({
      next: ({ backendSha }) => this.backendSha.set(backendSha.slice(0, 7)),
      error: () => this.backendSha.set('unknown'),
    });
  }

  selectSurface(surface: DefaultClaudeSessionSurface): void {
    if (
      this.appSettings.saving() ||
      this.appSettings.settings().defaultClaudeSessionSurface === surface
    ) {
      return;
    }

    void this.appSettings
      .saveDefaultClaudeSessionSurface(surface)
      .catch(() => toast.error('Could not save settings.'));
  }

  async openExternal(url: string, event: MouseEvent) {
    event.preventDefault();

    if (this.externalLinks) {
      await this.externalLinks.open(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
