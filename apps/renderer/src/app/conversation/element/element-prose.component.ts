import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { BROWSER_ELEMENT_MARKERS } from "@elevenex/shared";
import type { ConversationAttachment } from "../conversation.models";
import { ElementChipComponent } from "./element-chip.component";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";

type ProsePart =
  | { readonly text: string }
  | { readonly file: ConversationAttachment };

/**
 * Sent prose with named, inspectable element mentions. Markers without a
 * matching element stay as the plain character the person wrote.
 */
@Component({
  selector: "ex-element-prose",
  imports: [ElementChipComponent],
  template: `@for (part of parts(); track $index) {@if ("file" in part) {<ex-element-chip [file]="part.file" [resolve]="resolve()" [inline]="true" />} @else {<ng-container>{{ part.text }}</ng-container>}}`,
  styles: `
    :host { display: inline; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementProseComponent {
  readonly text = input("");
  readonly attachments = input<readonly ConversationAttachment[]>([]);
  readonly resolve = input<MarkdownAssetResolver>();
  readonly parts = computed<readonly ProsePart[]>(() => {
    const labels = new Map(
      this.attachments().flatMap((file) =>
        file.element && file.marker ? [[file.marker, file] as const] : [],
      ),
    );
    const text = this.text();
    if (!labels.size) return [{ text }];
    const parts: ProsePart[] = [];
    let run = "";
    for (const char of text) {
      const marker = (BROWSER_ELEMENT_MARKERS as readonly string[]).indexOf(char) + 1;
      const file = labels.get(marker);
      if (file === undefined) {
        run += char;
        continue;
      }
      if (run) parts.push({ text: run });
      run = "";
      parts.push({ file });
    }
    if (run) parts.push({ text: run });
    return parts;
  });
}
