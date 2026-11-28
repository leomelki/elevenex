import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import type { MarkdownInline } from "./markdown-parser";
@Component({
  selector: "ex-markdown-inline",
  imports: [NgTemplateOutlet],
  templateUrl: "./markdown-inline.component.html",
  styleUrl: "./markdown-inline.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownInlineComponent {
  readonly nodes = input.required<readonly MarkdownInline[]>();
  readonly openFile = output<string>();
  readonly openLink = output<string>();
}
