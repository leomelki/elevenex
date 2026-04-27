import { Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUpRight, lucideInfo } from '@ng-icons/lucide';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';

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

  async openExternal(url: string, event: MouseEvent) {
    event.preventDefault();

    if (this.externalLinks) {
      await this.externalLinks.open(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
