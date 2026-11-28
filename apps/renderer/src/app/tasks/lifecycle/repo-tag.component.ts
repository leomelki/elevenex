import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { Repo } from "../task.models";

/** Repository identity is deliberately quiet: status colors belong to sessions. */
@Component({
  selector: "ex-repo-tag",
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.medium]": "size() === 'md'",
    "[attr.title]": "description()",
  },
  templateUrl: "./repo-tag.component.html",
  styleUrl: "./repo-tag.component.css",
})
export class RepoTagComponent {
  readonly repo = input.required<Repo | string>();
  readonly size = input<"sm" | "md">("sm");
  private readonly identity = computed<Repo>(() => {
    const repo = this.repo();
    return typeof repo === "string" ? { name: repo } : repo;
  });
  protected readonly label = computed(
    () => this.identity().short || this.identity().name,
  );
  protected readonly description = computed(
    () =>
      this.identity().name +
      (this.identity().path ? ` · ${this.identity().path}` : ""),
  );
}
