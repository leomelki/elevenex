import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ElevenexBridge, TaskBrowserFrame, TaskBrowserSurface, TaskBrowserStreamInput } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../src/app/backend/backend-client.service';
import { BrowserStreamComponent } from '../src/app/task-browser/browser-stream.component';

class VideoFixture implements Pick<ElevenexBridge, 'onTaskBrowserFrame' | 'taskBrowserFrameAck' | 'taskBrowserInput'> {
  private listener?: (frame: TaskBrowserFrame) => void;
  readonly acknowledgments: { sequence: number; decoded?: boolean }[] = [];
  readonly inputs: TaskBrowserStreamInput[] = [];
  async taskBrowserInput(_scope: string, _task: number, _tab: string, generation: number, input: TaskBrowserStreamInput): Promise<number> {
    if (this.inputs.length >= 128) this.inputs.shift();
    this.inputs.push(input);
    return generation;
  }
  onTaskBrowserFrame(listener: (frame: TaskBrowserFrame) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  async taskBrowserFrameAck(_scope: string, _task: number, _tab: string, _stream: string, sequence: number, decoded?: boolean): Promise<void> {
    if (this.acknowledgments.length >= 64) this.acknowledgments.shift();
    this.acknowledgments.push({ sequence, decoded });
  }
  deliver(frame: TaskBrowserFrame): void { this.listener?.(frame); }
}

/** Capture fixtures only; encoded bytes are supplied by an external real encoder. */
@Component({
  selector: 'ex-browser-video-demo',
  imports: [BrowserStreamComponent],
  providers: [VideoFixture, { provide: ELEVENEX_BRIDGE, useExisting: VideoFixture }],
  template: '<h1>Remote browser video</h1><div class="page"><ex-browser-stream [surface]="surface()" /></div>',
  styles: ':host { display: block; padding: var(--space-4); } h1 { font-size: var(--text-title-size); margin: 0 0 var(--space-4); } .page { position: relative; aspect-ratio: 4 / 3; max-width: 800px; border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; } ex-browser-stream { position: absolute; inset: 0; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserVideoDemoComponent {
  readonly fixture = inject(VideoFixture);
  readonly surface = signal<TaskBrowserSurface>({ scopeId: 'preview', taskId: 1, tabId: 'video-tab', partition: '', bootstrap: '', bounds: { x: 0, y: 0, width: 800, height: 600 }, viewport: { width: 800, height: 600 }, zoom: 1, visible: true, generation: 1, interactive: true, driver: 'you', presentation: 'stream' });
}
