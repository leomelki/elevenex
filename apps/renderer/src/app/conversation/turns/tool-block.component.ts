import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { IconComponent, StatusGlyphComponent } from "../../ui";
import type { ToolBlock } from "../tool-presentation";
import { toolDiffLines } from "./tool-diff-lines";

/** Shared inert evidence rendering for a concise preview and its full disclosure. */
@Component({
  selector: "ex-tool-block",
  imports: [IconComponent, StatusGlyphComponent],
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
    if (block.kind === "diff" || block.kind === "patch")
      return { ...block, lines: toolDiffLines(block) };
    return block;
  });
}
