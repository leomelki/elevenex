import { TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownMediaComponent } from "./markdown-media.component";

const imageSource = "data:image/png;base64,iVBORw0KGgo=";
const source = "data:video/webm;base64,GkXfow==";
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

describe("media presentation", () => {
  it('retains the image frame and caption across missing, loading, ready and failed sources', async () => {
    const fixture = TestBed.createComponent(MarkdownMediaComponent);
    fixture.componentRef.setInput('path', '/screen.png');
    fixture.componentRef.setInput('caption', 'Workspace');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const frame = root.querySelector('.media-frame');
    const caption = root.querySelector('figcaption');
    expect(frame).not.toBeNull();
    expect(frame?.textContent).toContain('Image unavailable');
    fixture.componentRef.setInput('asset', { kind: 'image', src: '', w: 0, h: 0, loading: true });
    fixture.detectChanges();
    expect(root.querySelector('.media-frame')).toBe(frame);
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(frame?.textContent).toContain('Loading image');
    fixture.componentRef.setInput('asset', { kind: 'image', src: imageSource, w: 1800, h: 2800 });
    fixture.detectChanges();
    expect(root.querySelector('.media-frame')).toBe(frame);
    expect(root.querySelector('figcaption')).toBe(caption);
    expect(root.querySelector('img')?.getAttribute('src')).toBe(imageSource);
    root.querySelector('img')?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(root.querySelector('.media-frame')).toBe(frame);
    expect(root.querySelector('img')).toBeNull();
    expect(frame?.textContent).toContain('Image unavailable');
    const open = vi.fn(); fixture.componentInstance.openFile.subscribe(open);
    frame?.querySelector<HTMLButtonElement>('button')?.click();
    expect(open).toHaveBeenCalledWith('/screen.png');
  });

  it('keeps recording frame and control space through loading and errors', () => {
    const fixture = TestBed.createComponent(MarkdownMediaComponent);
    fixture.componentRef.setInput('path', '/recording.webm');
    fixture.componentRef.setInput('caption', 'Walkthrough');
    fixture.componentRef.setInput('asset', { kind: 'video', src: '', w: 0, h: 0, loading: true });
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const frame = root.querySelector('.media-window');
    const controls = root.querySelector('.controls');
    expect(frame?.textContent).toContain('Loading recording');
    expect(root.querySelector('input')?.disabled).toBe(true);
    fixture.componentRef.setInput('asset', { kind: 'video', src: source, w: 0, h: 0 });
    fixture.detectChanges();
    expect(root.querySelector('.media-window')).toBe(frame);
    expect(root.querySelector('.controls')).toBe(controls);
    expect(root.querySelector('input')?.disabled).toBe(false);
    root.querySelector('video')?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(root.querySelector('.media-window')).toBe(frame);
    expect(root.querySelector('.controls')).toBe(controls);
    expect(root.querySelector('input')?.disabled).toBe(true);
  });

  it('pauses the mounted recording when its owner hides the media', () => {
    const fixture = TestBed.createComponent(MarkdownMediaComponent);
    fixture.componentRef.setInput('path', '/recording.webm');
    fixture.componentRef.setInput('asset', { kind: 'video', src: source, w: 0, h: 0 });
    fixture.detectChanges();
    const video = (fixture.nativeElement as HTMLElement).querySelector('video')!;
    vi.spyOn(video, 'paused', 'get').mockReturnValue(false);
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    expect(pause).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('video')).toBe(video);
  });

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
