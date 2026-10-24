import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import {
  GitBarComponent,
  TaskHeaderComponent,
  type GitJob,
} from "../src/app/tasks";
import { JobBriefComponent } from "../src/app/conversation";
import { ButtonComponent } from "../src/app/ui";

@Component({
  selector: "ex-git-jobs-demo",
  imports: [
    GitBarComponent,
    TaskHeaderComponent,
    JobBriefComponent,
    ButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./git-jobs-demo.component.html",
  styleUrl: "./git-jobs-demo.component.css",
})
export class GitJobsDemoComponent {
  readonly lastIntent = signal("");
  readonly waiting = signal(false);
  readonly running = signal(true);
  readonly job: GitJob = {
    id: "merge-null-cart",
    title: "Merge into flaky-checkout",
    verb: "Merging",
    steps: [
      {
        id: "sync",
        status: "done",
        label: "Synced with flaky-checkout",
        detail: "3 commits · pnpm-lock.yaml regenerated",
      },
      {
        id: "resolve",
        status: "running",
        label: "Resolving 3 conflicts",
        detail: "payments/client.ts, test/checkout.spec.ts",
        short: "resolving 3 conflicts",
        session: { id: "helper", title: "Resolve merge conflicts" },
      },
      { id: "merge", status: "queued", label: "Merge 2 commits" },
      {
        id: "cleanup",
        status: "queued",
        label: "Clean up the branch and workspace",
      },
    ],
  };
}
