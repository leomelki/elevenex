import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ThemeService } from "./shell/theme.service";
@Component({
  selector: "ex-root",
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class AppComponent {
  private readonly theme = inject(ThemeService);
}
