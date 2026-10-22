import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { ICON_PATHS } from "./icon-paths";

@Component({
  selector: "ex-icon",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "aria-hidden": "true" },
  template: `<svg
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    [attr.stroke-width]="name() === 'more' ? 2.4 : 1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path [attr.d]="path()" />
  </svg>`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      vertical-align: middle;
    }
    svg {
      display: block;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<string>();
  readonly size = input(16);
  protected readonly path = computed(
    () => ICON_PATHS[this.name()] ?? ICON_PATHS["question"],
  );
}
