import { DecimalPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import type { BrowserElementReference } from "@elevenex/shared";
import { ButtonComponent, IconComponent } from "../../ui";
import type { ConversationAttachment } from "../conversation.models";
import type { MarkdownAssetResolver } from "../markdown/markdown-parser";
import {
  elementImageSource,
  elementPlace,
  splitElementLabel,
  targetInCrop,
} from "./element-geometry";
import { ElementPinComponent } from "./element-pin.component";

/**
 * The full historical snapshot of one browser element: the crop with its target
 * outlined, where and when it was picked, and the page's own source hint.
 * Presentational; the owner handles every intent.
 */
@Component({
  selector: "ex-element-preview",
  imports: [DecimalPipe, ButtonComponent, IconComponent, ElementPinComponent],
  templateUrl: "./element-preview.component.html",
  styleUrl: "./element-preview.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementPreviewComponent {
  readonly file = input.required<ConversationAttachment>();
  readonly resolve = input<MarkdownAssetResolver>();
  /** Shows draft actions: insert the pin, pick again, remove. */
  readonly editing = input(false);
  readonly disabled = input(false);
  readonly pickAvailable = input(false);
  /** Inline in a tight region: image and identity only, without the note and technical details. */
  readonly compact = input(false);
  /** Labels the heading for an enclosing dialog. */
  readonly headingId = input(`element-preview-${crypto.randomUUID()}`);
  readonly mention = output<void>();
  readonly repick = output<BrowserElementReference>();
  readonly removed = output<string>();
  readonly retry = output<string>();

  readonly element = computed(() => this.file().element);
  readonly marker = computed(() => this.file().marker);
  readonly source = computed(() =>
    elementImageSource(this.file(), this.resolve()),
  );
  readonly label = computed(() =>
    splitElementLabel(this.element()?.label ?? ""),
  );
  readonly place = computed(() => elementPlace(this.element()?.page ?? ""));
  readonly outline = computed(() => {
    const element = this.element();
    if (!element) return null;
    const box = targetInCrop(element);
    return box.width && box.height
      ? {
          left: `${box.left * 100}%`,
          top: `${box.top * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
        }
      : null;
  });
  readonly captured = computed(() => {
    const date = new Date(this.element()?.capturedAt ?? "");
    if (!Number.isFinite(date.getTime())) return "";
    const today = new Date().toDateString() === date.toDateString();
    return new Intl.DateTimeFormat(
      undefined,
      today
        ? { timeStyle: "short" }
        : { dateStyle: "medium", timeStyle: "short" },
    ).format(date);
  });
  readonly hint = computed(() => {
    const element = this.element();
    const source = element?.source;
    if (source)
      return {
        file: source.file.split("/").slice(-2).join("/"),
        full: `${source.file}:${source.line}${source.column ? ":" + source.column : ""}`,
        line: source.line,
        note:
          source.relation === "ancestor"
            ? "Enclosing element, as reported by the page"
            : "As reported by the page",
      };
    const component = element?.componentSource;
    return component
      ? {
          file: component.file.split("/").slice(-2).join("/"),
          full: `${component.file}${component.line ? ":" + component.line : ""}`,
          line: component.line,
          note: "Component, as reported by the page",
        }
      : null;
  });
}
