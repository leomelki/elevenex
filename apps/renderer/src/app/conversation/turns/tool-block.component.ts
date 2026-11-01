import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { StatusGlyphComponent } from "../../ui";
import type { ToolBlock } from "../tool-presentation";

/** A terminal newline terminates a line; it does not add a phantom diff row. */
function evidenceLines(text: string): readonly string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

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
        removed: evidenceLines(block.before),
        added: evidenceLines(block.after),
      };
    if (block.kind === "patch") {
      let inHunk = false;
      let oldRemaining: number | undefined;
      let newRemaining: number | undefined;
      return {
        ...block,
        lines: evidenceLines(block.text).map((text) => {
          if (text.startsWith("@@")) {
            const range = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
            oldRemaining = range ? Number(range[1] ?? 1) : undefined;
            newRemaining = range ? Number(range[2] ?? 1) : undefined;
            inHunk = !range || oldRemaining !== 0 || newRemaining !== 0;
            return { text, tone: "context" };
          }
          if (text.startsWith("***") || text.startsWith("diff --git ")) {
            inHunk = text.startsWith("*** Add File:");
            oldRemaining = newRemaining = undefined;
            return { text, tone: "context" };
          }
          const header =
            !inHunk && (text.startsWith("+++ ") || text.startsWith("--- "));
          const tone = header
            ? "context"
            : text.startsWith("+")
              ? "added"
              : text.startsWith("-")
                ? "removed"
                : "";
          if (
            inHunk &&
            oldRemaining !== undefined &&
            newRemaining !== undefined
          ) {
            if (text.startsWith("-") || text.startsWith(" ")) oldRemaining--;
            if (text.startsWith("+") || text.startsWith(" ")) newRemaining--;
            if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
          }
          return { text, tone };
        }),
      };
    }
    return block;
  });
}
