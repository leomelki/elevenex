import type { TaskBrowserFrame } from '@elevenex/shared';
import type { RemoteBrowserVideo } from './remote-video';

type Frame = Omit<TaskBrowserFrame, 'scopeId' | 'taskId' | 'tabId' | 'streamId'>;
interface Presentation {
  readonly tabId: string;
  sequence: number;
  jpegAfter: number;
  videoAfter: number;
  reading: boolean;
}

/** Codec selection and source cursors belong to the transport, not the display.
 * A JPEG bootstrap makes pixels/input available without waiting for an encoder.
 * Display receipts use an independent sequence across JPEG/video/fallback.
 */
export class RemoteBrowserFrames {
  private readonly presentations = new Map<string, Presentation>();
  constructor(
    private readonly video: RemoteBrowserVideo,
    private readonly jpeg: (tabId: string, after: number, key: string) => Promise<Frame | null>,
  ) {}
  async next(tabId: string, after: number, key: string, videoWindow?: number): Promise<Frame | null> {
    let entry = this.presentations.get(key);
    if (!entry) {
      if (this.presentations.size >= 48) throw new Error('Browser presentation limit reached');
      entry = { tabId, sequence: 0, jpegAfter: 0, videoAfter: 0, reading: false };
      this.presentations.set(key, entry);
    }
    if (entry.tabId !== tabId || entry.reading || after !== entry.sequence)
      throw new Error('Invalid frame receipt');
    entry.reading = true;
    try {
      let frame: Frame | null = null;
      if (entry.sequence && videoWindow !== undefined && this.video.available(key)) {
        frame = await this.video.next(tabId, entry.videoAfter, key, videoWindow);
        if (this.presentations.get(key) !== entry) return null;
        if (frame) entry.videoAfter = frame.sequence;
        else if (this.video.available(key)) return null;
      }
      if (!frame) {
        frame = await this.jpeg(tabId, entry.jpegAfter, key);
        if (frame) entry.jpegAfter = frame.sequence;
      }
      if (!frame || this.presentations.get(key) !== entry) return null;
      return { ...frame, sequence: ++entry.sequence };
    } finally {
      entry.reading = false;
    }
  }
  cancel(key: string): void {
    this.presentations.delete(key);
    this.video.cancel(key);
  }
  destroy(): void {
    this.presentations.clear();
    this.video.destroy();
  }
}
