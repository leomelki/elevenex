import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { ButtonComponent, IconComponent, StatusGlyphComponent } from "../../ui";
import type { GitJob } from "../task.models";

@Component({
  selector: "ex-git-job-menu",
  imports: [ButtonComponent, IconComponent, StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./git-job-menu.component.html",
  styleUrls: ["../tasks-menu.css", "./git-job-menu.component.css"],
  host: {
    role: "dialog",
    "[attr.aria-label]": "job().title ?? 'Job'",
    tabindex: "-1",
  },
})
export class GitJobMenuComponent {
  readonly job = input.required<GitJob>();
  readonly sessionRequested = output<string>();
  readonly cancelled = output<void>();
}
