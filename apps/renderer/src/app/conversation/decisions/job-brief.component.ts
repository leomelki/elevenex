import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { IconComponent } from "../../ui";

/** Opening message for an owner-created git helper session; content is supplied. */
@Component({
  selector: "ex-job-brief",
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./job-brief.component.html",
  styleUrl: "./job-brief.component.css",
  host: { "[attr.data-msg]": "id()" },
})
export class JobBriefComponent {
  readonly title = input("started this session for a git job");
  readonly time = input<string>();
  readonly id = input<string>();
}
