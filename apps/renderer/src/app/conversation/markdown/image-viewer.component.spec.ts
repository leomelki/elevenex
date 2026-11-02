import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownMediaComponent } from "./markdown-media.component";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

async function openViewer() {
  const fixture = TestBed.createComponent(MarkdownMediaComponent);
  fixture.componentRef.setInput("path", "/workspace.png");
  fixture.componentRef.setInput("caption", "Workspace illustration");
  fixture.componentRef.setInput("asset", { kind: "image", src: "data:image/png;base64,AA==", w: 1600, h: 900 });
  fixture.detectChanges();
  const trigger: HTMLButtonElement = fixture.nativeElement.querySelector("button.image");
  trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable();
  const dialog = document.querySelector<HTMLElement>('.image-viewer[role="dialog"]')!;
  return { fixture, trigger, dialog };
}

describe("image viewer", () => {
  it("dismisses with Escape, the backdrop, the empty canvas and the close control, restoring its thumbnail", async () => {
    const { fixture, trigger } = await openViewer();
    for (const dismiss of ["escape", "backdrop", "canvas", "close"]) {
      if (dismiss !== "escape") { trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable(); }
      const dialog = document.querySelector<HTMLElement>(".image-viewer")!;
      expect(dialog.getAttribute("aria-label")).toBe("Workspace illustration");
      if (dismiss === "escape") dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else if (dismiss === "backdrop") dialog.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      else dialog.querySelector<HTMLButtonElement>(dismiss === "canvas" ? ".canvas-dismiss" : ".close button")!.click();
      fixture.detectChanges(); await fixture.whenStable();
      expect(document.querySelector(".image-viewer")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    }
  });

  it("keeps image/toolbar interactions open and supports bounded keyboard zoom and reset", async () => {
    const { fixture, dialog } = await openViewer();
    const image = dialog.querySelector("img")!;
    Object.defineProperties(image, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
    image.dispatchEvent(new Event("load")); fixture.detectChanges();
    dialog.querySelector("header")!.click();
    const key = (value: string) => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
      fixture.detectChanges();
    };
    for (let i = 0; i < 15; i++) key("+");
    expect(dialog.querySelector(".zoom-value")!.textContent).toBe("300%");
    expect(dialog.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.disabled).toBe(true);
    key("0");
    expect(dialog.querySelector(".zoom-value")!.textContent).toBe("Fit");
    dialog.querySelector<HTMLButtonElement>(".picture")!.click(); fixture.detectChanges();
    expect(document.querySelector(".image-viewer")).toBe(dialog);
    expect(dialog.querySelector(".zoom-value")!.textContent).toBe("200%");
  });

  it("keeps dismissal available during loading and decode failure, with zoom disabled", async () => {
    const { fixture, dialog } = await openViewer();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain("Loading image");
    expect(dialog.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.disabled).toBe(true);
    dialog.querySelector("img")!.dispatchEvent(new Event("error")); fixture.detectChanges();
    expect(dialog.querySelector('[role="status"]')!.textContent).toContain("Image unavailable");
    expect(dialog.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.disabled).toBe(true);
    dialog.querySelector<HTMLButtonElement>(".close button")!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector(".image-viewer")).toBeNull();
  });

  it("retains the resolved source if the thumbnail's asset changes while open, and removes overlays on destruction", async () => {
    const { fixture, dialog } = await openViewer();
    const source = dialog.querySelector("img")!.getAttribute("src");
    fixture.componentRef.setInput("asset", { kind: "image", src: "data:image/png;base64,AQ==", w: 20, h: 20 });
    fixture.componentRef.setInput("caption", "Updated illustration"); fixture.detectChanges();
    expect(dialog.querySelector("img")!.getAttribute("src")).toBe(source);
    expect(dialog.getAttribute("aria-label")).toBe("Workspace illustration");
    const removeListener = vi.spyOn(dialog.querySelector(".viewport")!, "removeEventListener");
    fixture.destroy();
    expect(document.querySelector(".image-viewer")).toBeNull();
    expect(removeListener).toHaveBeenCalledWith("wheel", expect.any(Function));
  });
});
