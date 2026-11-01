import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { StatusGlyphComponent } from "../../ui";
import type { ToolBlock } from "../tool-presentation";

/** Shared inert evidence rendering for a concise preview and its full disclosure. */
@Component({
  selector: "ex-tool-block",
  imports: [StatusGlyphComponent],
  templateUrl: "./tool-block.component.html",
  styleUrl: "./tool-block.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class.compact]": "compact()" },
})
export class ToolBlockComponent {
  readonly block = input.required<ToolBlock>();
  readonly compact = input(false);
  readonly view = computed(() => {
    const block = this.block();
    if (block.kind === "diff")
      return {
        ...block,
        removed: block.before === "" ? [] : block.before.split("\n"),
        added: block.after === "" ? [] : block.after.split("\n"),
      };
    if (block.kind === "patch")
      return {
        ...block,
        lines: block.text.split("\n").map((text) => ({
          text,
          tone:
            text.startsWith("+++") ||
            text.startsWith("---") ||
            text.startsWith("***") ||
            text.startsWith("@@")
              ? "context"
              : text.startsWith("+")
                ? "added"
                : text.startsWith("-")
                  ? "removed"
                  : "",
        })),
      };
    return block;
  });
}
