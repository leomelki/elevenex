import { ZardDropdownMenuItemComponent } from '@/shared/components/dropdown';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck } from '@ng-icons/lucide';

/** Shared label/description layout for the status bar's settings menus. */
@Component({
  selector: 'cw-setting-option',
  imports: [ZardDropdownMenuItemComponent, NgIcon],
  viewProviders: [provideIcons({ lucideCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      z-dropdown-menu-item
      class="w-full items-start gap-3 text-left text-xs data-[selected=true]:bg-primary/10"
      [attr.data-selected]="selected()"
      [attr.aria-checked]="selected()"
      [attr.role]="'menuitemradio'"
      (click)="picked.emit()"
    >
      <span class="min-w-0 flex-1">
        <strong class="block font-medium">{{ label() }}</strong>
        @if (description()) {
          <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{{
            description()
          }}</span>
        }
      </span>
      <ng-icon
        name="lucideCheck"
        size="14"
        class="mt-0.5 shrink-0"
        [class.invisible]="!selected()"
        aria-hidden="true"
      />
    </button>
  `,
})
export class AgentSettingOptionComponent {
  readonly label = input.required<string>();
  readonly description = input('');
  readonly selected = input(false);
  readonly picked = output<void>();
}
