import { ChangeDetectionStrategy, Component, input } from "@angular/core";

/** A native button retains forms, focus, disabled behavior and click semantics. */
@Component({
  selector: "button[exButton]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[attr.data-variant]": "variant()",
    "[attr.data-size]": "size()",
    type: "button",
  },
  template: `<ng-content />`,
  styleUrl: "./button.component.css",
})
export class ButtonComponent {
  readonly variant = input<"primary" | "secondary" | "ghost" | "danger">(
    "secondary",
  );
  readonly size = input<"md" | "sm">("md");
}
