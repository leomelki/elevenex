import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { MarkdownInlineComponent } from "./markdown-inline.component";
import { MarkdownCodeComponent } from "./markdown-code.component";
import { MarkdownMediaGroupComponent } from "./markdown-media-group.component";
import { MarkdownMediaComponent } from "./markdown-media.component";
import {
  parseMarkdown,
  type MarkdownAssetResolver,
  type MarkdownBlock,
} from "./markdown-parser";

function finalBlock(
  blocks: readonly MarkdownBlock[],
): MarkdownBlock | undefined {
  const last = blocks.at(-1);
  if (last?.kind === "quote") return finalBlock(last.blocks);
  if (last?.kind === "list") return finalBlock(last.items.at(-1)?.blocks ?? []);
  return last;
}
@Component({
  selector: "ex-markdown",
  imports: [
    NgTemplateOutlet,
    MarkdownInlineComponent,
    MarkdownMediaComponent,
    MarkdownCodeComponent,
    MarkdownMediaGroupComponent,
  ],
  templateUrl: "./markdown.component.html",
  styleUrl: "./markdown.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownComponent {
  readonly source = input.required<string>();
  readonly streaming = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly blocks = computed(() =>
    parseMarkdown(this.source(), this.streaming()),
  );
  readonly streamingCode = computed(() => {
    const last = finalBlock(this.blocks());
    return this.streaming() && last?.kind === "code" && !last.complete
      ? last
      : null;
  });
  readonly textCursor = computed(
    () => this.streaming() && !this.streamingCode(),
  );
  readonly openFile = output<string>();
  readonly openLink = output<string>();
  readonly openPage = output<string>();
  readonly copyCode = output<string>();
}
