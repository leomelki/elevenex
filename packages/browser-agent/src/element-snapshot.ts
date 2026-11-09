import { object, type BrowserAgentTarget } from "./host.js";
import type { BrowserRect, BrowserElementSnapshot } from "@elevenex/shared";
import type { Page, Locator } from "playwright-core";
import { randomUUID } from "node:crypto";

/** Limit raster work before requesting pixels. CSS scale avoids DPR-sized images. */
export function elementCrop(
  target: BrowserRect,
  viewport: { width: number; height: number },
  point: { x: number; y: number },
): BrowserRect {
  const left = Math.max(0, target.x - 48),
    top = Math.max(0, target.y - 48);
  const right = Math.min(viewport.width, target.x + target.width + 48),
    bottom = Math.min(viewport.height, target.y + target.height + 48);
  const width = Math.min(1600, right - left),
    height = Math.min(1600, bottom - top);
  if (
    ![left, top, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Element is outside the visible page");
  return {
    x: Math.floor(Math.max(left, Math.min(right - width, point.x - width / 2))),
    y: Math.floor(
      Math.max(top, Math.min(bottom - height, point.y - height / 2)),
    ),
    width: Math.floor(width),
    height: Math.floor(height),
  };
}
export async function captureElementSnapshot(
  page: Page,
  locator: Locator,
  selection: {
    selector: string;
    frames: readonly string[];
    tag: string;
    documentId: string;
  },
  tabId: string,
  point: { x: number; y: number },
  current: () => boolean,
  target: BrowserAgentTarget,
): Promise<BrowserElementSnapshot> {
  const identity = () =>
    page.evaluate<{
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
      dpr: number;
      scale: number;
      x: number;
      y: number;
    }>(
      "({ width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio, scale: visualViewport?.scale, x: visualViewport?.offsetLeft, y: visualViewport?.offsetTop })",
    );
  const before = await identity();
  const box = await locator.boundingBox({ timeout: 1500 });
  if (!box || !current()) throw new Error("Selected element changed");
  const crop = elementCrop(box, before, point);
  const label = await locator.evaluate((node) => {
    // Field contents belong only to the user-reviewed pixels, never metadata.
    const editable = !!node.closest("input,textarea,select,[contenteditable]");
    return String(
      node.getAttribute("aria-label") ||
        (editable ? node.getAttribute("placeholder") : node.textContent) ||
        "",
    )
      .split("")
      .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110);
  });
  const url = new URL(page.url());
  const reference = {
    version: 1 as const,
    id: randomUUID(),
    label: `${selection.tag} · ${label || "Selected element"}`.slice(0, 160),
    tag: selection.tag,
    selector: selection.selector,
    frames: selection.frames,
    page: (url.origin + url.pathname).slice(0, 2048),
    tabId,
    documentId: selection.documentId,
    capturedAt: new Date().toISOString(),
    target: box,
    crop,
    image: { width: crop.width, height: crop.height, scale: 1 },
  };
  try {
    const metrics = object(await target.send("Page.getLayoutMetrics", {}));
    const visual = object(metrics["cssVisualViewport"]);
    const zoom = typeof visual["zoom"] === "number" ? visual["zoom"] : 1;
    // Electron page zoom contributes to JS DPR, but screenshot rasterization
    // uses zoom-scaled document DIPs and the display scale. Compensate explicitly rather than Playwright's
    // CSS screenshot shortcut, which shrinks zoomed Electron crops.
    const scale = 1 / before.dpr;
    if (
      !Number.isFinite(scale) ||
      scale <= 0 ||
      scale > 2 ||
      before.scale !== 1
    )
      throw new Error("Unsupported viewport scale");
    const result = object(
      await target.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 75,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: (crop.x + before.scrollX) * zoom,
          y: (crop.y + before.scrollY) * zoom,
          width: crop.width,
          height: crop.height,
          scale,
        },
      }),
    );
    if (typeof result["data"] !== "string" || result["data"].length > 1_000_000)
      throw new Error("Snapshot exceeds the image limit");
    const bytes = Buffer.from(result["data"], "base64");
    const dimensions = jpegDimensions(bytes);
    if (dimensions.width > 1600 || dimensions.height > 1600)
      throw new Error("Snapshot exceeds the pixel limit");
    const after = await identity(),
      afterBox = await locator.boundingBox({ timeout: 1000 });
    if (
      !current() ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(box) !== JSON.stringify(afterBox)
    )
      throw new Error("Page moved during capture");
    if (bytes.length > 750_000)
      return {
        reference,
        error: "Snapshot exceeds the image limit. Pick a smaller element.",
      };
    return {
      reference: {
        ...reference,
        image: { ...dimensions, scale: dimensions.width / crop.width },
      },
      jpeg: bytes.toString("base64"),
    };
  } catch {
    if (
      !current() ||
      JSON.stringify(before) !== JSON.stringify(await identity())
    )
      throw new Error("Page changed during capture");
    return {
      reference,
      error: "Snapshot unavailable. Pick the element again.",
    };
  }
}

/** Chromium emits baseline/progressive JPEGs. Read the frame header without a
 * decoder or unbounded image allocation, and report actual delivered pixels. */
function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.readUInt16BE(0) !== 0xffd8) throw new Error("Invalid JPEG");
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1],
      length = bytes.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc2)
      return {
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      };
    if (length < 2) break;
    offset += length + 2;
  }
  throw new Error("Missing JPEG dimensions");
}
