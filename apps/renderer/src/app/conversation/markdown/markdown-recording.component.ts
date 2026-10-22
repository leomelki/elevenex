import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  computed,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { IconButtonComponent } from "../../ui";
import { safeMediaSource } from "./markdown-parser";
@Component({
  selector: "ex-markdown-recording",
  imports: [IconButtonComponent],
  templateUrl: "./markdown-recording.component.html",
  styleUrl: "./markdown-recording.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownRecordingComponent {
  readonly knownDuration = input(0);
  readonly totalDuration = computed(
    () => this.duration() || this.knownDuration(),
  );
  readonly source = input.required<string>();
  readonly poster = input("");
  readonly caption = input("");
  readonly width = input(640);
  readonly height = input(360);
  readonly marks = input<
    readonly { readonly t: number; readonly label: string }[]
  >([]);
  readonly openFile = output<void>();
  readonly mediaError = signal(false);
  readonly video = viewChild<ElementRef<HTMLVideoElement>>("video");
  readonly playing = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly speed = signal(1);
  readonly safeSource = computed(() => safeMediaSource(this.source()));
  readonly safePoster = computed(() => safeMediaSource(this.poster()));
  readonly percent = computed(() =>
    this.totalDuration() > 0
      ? (this.currentTime() / this.totalDuration()) * 100
      : 0,
  );
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      const video = this.video()?.nativeElement;
      if (video && !video.paused) video.pause();
    });
  }
  async toggle(): Promise<void> {
    const video = this.video()?.nativeElement;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        this.mediaError.set(true);
      }
    } else video.pause();
  }
  updateTime(): void {
    const video = this.video()?.nativeElement;
    if (video) {
      this.currentTime.set(video.currentTime);
      this.duration.set(Number.isFinite(video.duration) ? video.duration : 0);
    }
  }
  seek(time: number): void {
    const video = this.video()?.nativeElement;
    if (video) {
      video.currentTime = Math.max(
        0,
        Math.min(this.totalDuration() || Number.MAX_SAFE_INTEGER, time),
      );
      this.currentTime.set(video.currentTime);
    }
  }
  scrub(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.seek(Number(event.target.value));
  }
  setSpeed(): void {
    const speed = this.speed() === 1 ? 1.5 : this.speed() === 1.5 ? 2 : 1;
    this.speed.set(speed);
    const video = this.video()?.nativeElement;
    if (video) video.playbackRate = speed;
  }
  async fullscreen(): Promise<void> {
    try {
      await this.video()?.nativeElement.requestFullscreen();
    } catch {
      this.mediaError.set(true);
    }
  }
  onKey(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (event.key === " ") {
      event.preventDefault();
      void this.toggle();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.seek(this.currentTime() - 5);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      this.seek(this.currentTime() + 5);
    }
  }
  time(value: number): string {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
}
