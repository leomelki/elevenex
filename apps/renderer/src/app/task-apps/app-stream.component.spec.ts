import { TestBed } from '@angular/core/testing';
import type { BackendResult, TaskAppFrame } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { H264Decoder } from '../media/h264-decoder';
import { AppStreamComponent } from './app-stream.component';

describe('App stream presentation', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('paints queued frames while a receipt is pending and acknowledges them cumulatively', async () => {
    let deliver!: (frame: TaskAppFrame) => void;
    let completeReceipt!: () => void;
    const ack = vi.fn(async (_scope: string, _watch: string, sequence: number) => {
      if (sequence === 1) await new Promise<void>(resolve => { completeReceipt = resolve; });
    });
    const watch = vi.fn<(scope: string, task: number, run: string, watch: string) => Promise<{ ok: true; value: undefined }>>(
      async () => ({ ok: true, value: undefined }),
    );
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(H264Decoder.prototype, 'decode').mockResolvedValue({ displayWidth: 1280, displayHeight: 800, close } as unknown as VideoFrame);
    TestBed.configureTestingModule({
      providers: [{ provide: ELEVENEX_BRIDGE, useValue: {
        onTaskAppFrame: (receive: (frame: TaskAppFrame) => void) => { deliver = receive; },
        taskAppWatch: watch,
        taskAppFrameAck: ack,
      } }],
    });
    const fixture = TestBed.createComponent(AppStreamComponent);
    fixture.componentRef.setInput('scopeId', 'machine');
    fixture.componentRef.setInput('taskId', 1);
    fixture.componentRef.setInput('runId', 'app');
    fixture.componentRef.setInput('name', 'App');
    fixture.detectChanges();
    await fixture.whenStable();
    const watchId = watch.mock.calls.at(0)?.[3];
    expect(watchId).toBeDefined();
    for (const sequence of [1, 2, 3]) {
      deliver({
        scopeId: 'machine', taskId: 1, runId: 'app', watchId: watchId!,
        sequence, width: 1280, height: 800, timestamp: sequence,
        codec: 'avc1.42E02A', data: Uint8Array.of(1), key: sequence === 1,
      });
    }
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3));
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(ack.mock.calls).toEqual([['machine', watchId, 1]]);
    completeReceipt();
    await vi.waitFor(() => expect(ack.mock.calls).toEqual([['machine', watchId, 1], ['machine', watchId, 3]]));
  });

  it('explains a refused display with the machine, keeps the code in details and reconnects with a new viewer', async () => {
    const watch = vi.fn<(scope: string, task: number, run: string, watch: string) => Promise<BackendResult<void>>>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Backend connection failed.' } })
      .mockResolvedValue({ ok: true, value: undefined });
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: { taskAppWatch: watch, taskAppUnwatch: vi.fn(async () => undefined) } }] });
    const fixture = TestBed.createComponent(AppStreamComponent);
    for (const [name, value] of Object.entries({ scopeId: 'machine', taskId: 1, runId: 'app', name: 'Dev app', machine: 'Studio Mac', remote: true }))
      fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    await vi.waitFor(() => { fixture.detectChanges(); expect(element.querySelector('.message strong')?.textContent).toBe('Can\'t reach Studio Mac'); });
    expect(element.querySelector('.message')?.textContent).toContain('Dev app isn\'t affected');
    expect(element.querySelector('.diagnostic')?.textContent).toContain('transport');
    element.querySelector<HTMLButtonElement>('.message button')!.click();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
    expect(watch.mock.calls[1]![3]).not.toBe(watch.mock.calls[0]![3]);
  });
});
