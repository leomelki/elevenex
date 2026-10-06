import { Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideZap } from '@ng-icons/lucide';

@Component({
  selector: 'app-preset-options-badges',
  imports: [NgIcon],
  host: { class: 'flex flex-wrap gap-1.5 text-[11px] text-muted-foreground' },
  viewProviders: [provideIcons({ lucideZap })],
  template: `
    <span class="rounded-md bg-muted px-2 py-1">{{ thinking() }}</span>
    @if (fast()) {
      <span class="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
        <ng-icon name="lucideZap" size="11" />Fast mode
      </span>
    }
  `,
})
export class PresetOptionsBadges {
  readonly thinking = input.required<string>();
  readonly fast = input(false);
}
