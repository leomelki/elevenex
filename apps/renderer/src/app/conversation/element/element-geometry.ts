import type { BrowserElementReference } from "@elevenex/shared";
import type { ConversationAttachment } from "../conversation.models";
import {
  safeMediaSource,
  type MarkdownAssetResolver,
} from "../markdown/markdown-parser";

/** A box in the coordinates of whatever displays the snapshot. */
export interface ElementBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The selected element's rectangle inside its crop, as fractions of the crop (0–1). */
export function targetInCrop(element: BrowserElementReference): ElementBox {
  const { target, crop } = element;
  const left = Math.max(0, target.x - crop.x);
  const top = Math.max(0, target.y - crop.y);
  const right = Math.min(crop.width, target.x + target.width - crop.x);
  const bottom = Math.min(crop.height, target.y + target.height - crop.y);
  return {
    left: left / crop.width,
    top: top / crop.height,
    width: Math.max(0, right - left) / crop.width,
    height: Math.max(0, bottom - top) / crop.height,
  };
}

/**
 * Frames a small thumbnail on the selected element rather than the whole crop:
 * the target fills most of the box, the box is always covered, and pixels are
 * never magnified past 1.5× their captured size.
 */
export function thumbnailFrame(
  element: BrowserElementReference,
  boxWidth: number,
  boxHeight: number,
): { readonly image: ElementBox; readonly target: ElementBox } {
  const { width: imageWidth, height: imageHeight } = element.image;
  const target = targetInCrop(element);
  const cover = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
  const fill = Math.min(
    (0.7 * boxWidth) / Math.max(1, target.width * imageWidth),
    (0.7 * boxHeight) / Math.max(1, target.height * imageHeight),
  );
  const scale = Math.max(cover, Math.min(fill, 1.5));
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const centerX = (target.left + target.width / 2) * width;
  const centerY = (target.top + target.height / 2) * height;
  const left = Math.min(0, Math.max(boxWidth - width, boxWidth / 2 - centerX));
  const top = Math.min(0, Math.max(boxHeight - height, boxHeight / 2 - centerY));
  return {
    image: { left, top, width, height },
    target: {
      left: left + target.left * width,
      top: top + target.top * height,
      width: target.width * width,
      height: target.height * height,
    },
  };
}

/** A staged preview, or the confined media resolver's image for history. */
export function elementImageSource(
  file: ConversationAttachment,
  resolve?: MarkdownAssetResolver,
): string {
  const asset = file.path ? resolve?.(file.path) : undefined;
  return safeMediaSource(
    file.preview || (asset?.kind === "image" ? asset.src : "") || "",
  );
}

/** `button · Save changes` → tag and readable name, for typographic hierarchy. */
export function splitElementLabel(label: string): {
  readonly tag: string;
  readonly name: string;
} {
  const index = label.indexOf(" · ");
  return index < 0
    ? { tag: "", name: label }
    : { tag: label.slice(0, index), name: label.slice(index + 3) };
}

/** Origin and path are already sanitized; drop the scheme for a quieter line. */
export function elementPlace(page: string): string {
  return page.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
