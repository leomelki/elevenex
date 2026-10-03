import { ZardDropdownMenuItemComponent } from '@/shared/components/dropdown';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Shared label/description layout for the status bar's settings menus. */
@Component({
  selector: 'cw-setting-option',
  imports: [ZardDropdownMenuItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      z-dropdown-menu-item
      class="w-full flex-col items-start gap-0.5 text-left text-xs data-[selected=true]:bg-primary/10"
      [attr.data-selected]="selected()"
      [attr.aria-checked]="selected()"
      [attr.role]="'menuitemradio'"
      (click)="picked.emit()"
    >
      <strong class="font-semibold">{{ label() }}</strong>
      @if (description()) {
        <span class="text-[11px] text-muted-foreground">{{ description() }}</span>
      }
    </button>
  `,
})
export class AgentSettingOptionComponent {
  readonly label = input.required<string>();
  readonly description = input('');
  readonly selected = input(false);
  readonly picked = output<void>();
}
