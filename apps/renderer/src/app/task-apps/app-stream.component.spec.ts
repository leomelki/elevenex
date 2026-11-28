import { TestBed } from '@angular/core/testing';
import { APP_SHARING_STOPPED, type BackendResult, type TaskAppFrame } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { H264Decoder } from '../media/h264-decoder';
import { AppStreamComponent } from './app-stream.component';

describe('App stream presentation', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('submits through decoder buffering, coalesces a paint burst and keeps logical display size', async () => {
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
    let submitted = 0;
    let ready!: () => void;
    const buffering = new Promise<void>(resolve => { ready = resolve; });
    vi.spyOn(H264Decoder.prototype, 'decode').mockImplementation(async (packet) => {
      if (++submitted === 2) ready();
      await buffering;
      return { displayWidth: packet.timestamp === 3 ? 640 : 1280, displayHeight: packet.timestamp === 3 ? 400 : 800, close } as unknown as VideoFrame;
    });
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
        sequence, width: sequence === 3 ? 640 : 1280, height: sequence === 3 ? 400 : 800, timestamp: sequence,
        ...(sequence === 3 ? { inputSize: { width: 1280, height: 800 } } : {}),
        codec: 'avc1.42E02A', data: Uint8Array.of(1), key: sequence !== 2,
      });
    }
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(3));
    expect(drawImage).toHaveBeenCalledTimes(2);
    const canvas: HTMLCanvasElement = fixture.nativeElement.querySelector('canvas');
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(400);
    expect(canvas.style.getPropertyValue('--app-display-width')).toBe('1280px');
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
    expect(element.querySelector('.message')?.textContent).toContain('Dev app is still running');
    expect(element.querySelector('.diagnostic')?.textContent).toContain('transport');
    element.querySelector<HTMLButtonElement>('.message button')!.click();
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(2));
    expect(watch.mock.calls[1]![3]).not.toBe(watch.mock.calls[0]![3]);
  });

  it.each(['App window changed. Reopen the stream.', 'App stream disconnected'])('recovers a bounded set of fresh views after %s', async reason => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let deliver!: (frame: TaskAppFrame) => void;
    let closed!: (event: { scopeId: string; watchId: string; reason: string }) => void;
    const watch = vi.fn<(scope: string, task: number, run: string, watch: string) => Promise<BackendResult<void>>>()
      .mockResolvedValue({ ok: true, value: undefined });
    const unwatch = vi.fn(async () => undefined);
    const input = vi.fn(async () => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(H264Decoder.prototype, 'decode').mockResolvedValue({ displayWidth: 640, displayHeight: 480, close: vi.fn() } as unknown as VideoFrame);
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: {
      taskAppWatch: watch, taskAppUnwatch: unwatch, taskAppInput: input,
      onTaskAppFrame: (fn: typeof deliver) => { deliver = fn; },
      onTaskAppClosed: (fn: typeof closed) => { closed = fn; },
    } }] });
    const fixture = TestBed.createComponent(AppStreamComponent);
    for (const [name, value] of Object.entries({ scopeId: 'machine', taskId: 1, runId: 'app', name: 'Dev app' }))
      fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await fixture.whenStable();
    const stream = fixture.componentInstance;
    const paint = async (watchId: string) => {
      deliver({ scopeId: 'machine', taskId: 1, runId: 'app', watchId, sequence: 1, width: 640, height: 480,
        timestamp: 0, codec: 'avc1.42E02A', data: Uint8Array.of(1), key: true });
      await Promise.resolve();
    };

    const watchId = () => watch.mock.lastCall![3];
    await paint(watchId());
    expect(stream.state()).toBe('live');
    stream.focus();
    for (const delay of [250, 750, 1500]) {
      const stale = watchId();
      closed({ scopeId: 'machine', watchId: stale, reason });
      await paint(stale);
      expect(stream.recovering()).toBe(true);
      expect(stream.controlling()).toBe(false);
      await vi.advanceTimersByTimeAsync(delay);
      expect(watchId()).not.toBe(stale);
      expect(unwatch).toHaveBeenCalledWith('machine', stale);
      await paint(watchId());
      expect(stream.state()).toBe('live');
    }
    closed({ scopeId: 'machine', watchId: watchId(), reason });
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch).toHaveBeenCalledTimes(4);
    expect(stream.state()).toBe('interrupted');
    expect(input).not.toHaveBeenCalled();

    await stream.start();
    await paint(watchId());
    closed({ scopeId: 'machine', watchId: watchId(), reason: APP_SHARING_STOPPED });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(watch).toHaveBeenCalledTimes(5);
    expect(stream.problem()?.title).toBe('App sharing stopped');
    await stream.start();
    expect(watch).toHaveBeenCalledTimes(6);
  });
});
