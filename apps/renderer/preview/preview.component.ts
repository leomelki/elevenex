import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { ThemeService } from "../src/app/shell/theme.service";

@Component({
  selector: "ex-root",
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./preview.component.html",
  styleUrl: "./preview.component.css",
})
export class PreviewComponent {
  protected readonly theme = inject(ThemeService);
}
