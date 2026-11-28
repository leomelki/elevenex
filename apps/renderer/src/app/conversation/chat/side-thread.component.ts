import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { ButtonComponent, IconComponent, IconButtonComponent } from "../../ui";
@Component({
  selector: "ex-side-thread",
  imports: [A11yModule, ButtonComponent, IconComponent, IconButtonComponent],
  templateUrl: "./side-thread.component.html",
  styleUrl: "./side-thread.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SideThreadComponent {
  readonly title = input("Side chat");
  readonly anchor = input("");
  readonly trapFocus = input(false);
  readonly closed = output<void>();
  readonly promote = output<void>();
}
