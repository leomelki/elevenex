import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownMediaComponent } from "./markdown-media.component";

const source = "data:video/webm;base64,GkXfow==";
afterEach(() => TestBed.resetTestingModule());

describe("media presentation", () => {
  it("retains a video's accessible name when its surrounding card supplies the visible caption", async () => {
    await TestBed.configureTestingModule({ imports: [MarkdownMediaComponent] }).compileComponents();
    const fixture = TestBed.createComponent(MarkdownMediaComponent);
    fixture.componentRef.setInput("path", "/walkthrough.webm");
    fixture.componentRef.setInput("caption", "Workspace walkthrough");
    fixture.componentRef.setInput("asset", { kind: "video", src: source, w: 640, h: 360 });
    fixture.componentRef.setInput("showCaption", false);
    fixture.componentRef.setInput("compact", true);
    fixture.detectChanges();
    const video: HTMLVideoElement = fixture.nativeElement.querySelector("video");
    expect(video.controls).toBe(true);
    expect(video.getAttribute("aria-label")).toBe("Workspace walkthrough");
    expect(video.autoplay).toBe(false);
    expect(fixture.nativeElement.querySelector("figcaption")).toBeNull();
  });

  it("preserves the recording controls and visible caption for ordinary Markdown videos", async () => {
    await TestBed.configureTestingModule({ imports: [MarkdownMediaComponent] }).compileComponents();
    const fixture = TestBed.createComponent(MarkdownMediaComponent);
    fixture.componentRef.setInput("path", "/walkthrough.webm");
    fixture.componentRef.setInput("caption", "Workspace walkthrough");
    fixture.componentRef.setInput("asset", { kind: "video", src: source, w: 640, h: 360 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("video").controls).toBe(false);
    expect(fixture.nativeElement.querySelector('[aria-label="Recording position"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector("figcaption").textContent).toBe("Workspace walkthrough");
  });
});
