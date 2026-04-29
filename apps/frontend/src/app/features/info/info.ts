import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUpRight, lucideInfo } from '@ng-icons/lucide';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { FRONTEND_GIT_SHA } from '../../../build-info';

@Component({
  selector: 'app-info',
  imports: [NgIcon],
  templateUrl: './info.html',
  styleUrl: './info.scss',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideInfo,
    }),
  ],
})
export class Info {
  private readonly externalLinks = getElectronExternalLinksApi();
  private readonly http = inject(HttpClient);

  readonly frontendSha = FRONTEND_GIT_SHA.slice(0, 7);
  readonly backendSha = signal('…');

  constructor() {
    this.http.get<{ backendSha: string }>('/api/info').subscribe({
      next: ({ backendSha }) => this.backendSha.set(backendSha.slice(0, 7)),
      error: () => this.backendSha.set('unknown'),
    });
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
