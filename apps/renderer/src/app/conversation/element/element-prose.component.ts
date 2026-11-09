import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { BROWSER_ELEMENT_MARKERS } from "@elevenex/shared";
import type { ConversationAttachment } from "../conversation.models";
import { ElementPinComponent } from "./element-pin.component";

type ProsePart =
  | { readonly text: string }
  | { readonly marker: number; readonly label: string };

/**
 * Sent prose with each element marker drawn as its pin. Markers without a
 * matching element stay as the plain character the person wrote.
 */
@Component({
  selector: "ex-element-prose",
  imports: [ElementPinComponent],
  template: `@for (part of parts(); track $index) {@if ("marker" in part) {<span class="pin" role="img" [attr.aria-label]="'pin ' + part.marker + ', ' + part.label" [title]="part.label"><ex-element-pin [marker]="part.marker" /></span>} @else {<ng-container>{{ part.text }}</ng-container>}}`,
  styles: `
    :host { display: inline; }
    .pin {
      display: inline-flex;
      vertical-align: -0.2em;
      margin: 0 1px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementProseComponent {
  readonly text = input("");
  readonly attachments = input<readonly ConversationAttachment[]>([]);
  readonly parts = computed<readonly ProsePart[]>(() => {
    const labels = new Map(
      this.attachments().flatMap((file) =>
        file.element && file.marker ? [[file.marker, file.element.label] as const] : [],
      ),
    );
    const text = this.text();
    if (!labels.size) return [{ text }];
    const parts: ProsePart[] = [];
    let run = "";
    for (const char of text) {
      const marker = (BROWSER_ELEMENT_MARKERS as readonly string[]).indexOf(char) + 1;
      const label = labels.get(marker);
      if (label === undefined) {
        run += char;
        continue;
      }
      if (run) parts.push({ text: run });
      run = "";
      parts.push({ marker, label });
    }
    if (run) parts.push({ text: run });
    return parts;
  });
}
