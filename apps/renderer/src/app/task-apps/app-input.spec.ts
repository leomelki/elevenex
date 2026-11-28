import { AppInputQueue, appPoint } from './app-input';
import type { TaskAppInput } from '@elevenex/shared';

describe('App displays', () => {
  it('maps the displayed canvas and clamps a captured drag to its last pixel', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 80, 320, 200));
    expect(appPoint(new MouseEvent('pointerdown', { clientX: 210, clientY: 180 }), canvas, 640, 400)).toEqual({ x: 320, y: 200 });
    expect(appPoint(new MouseEvent('pointerup', { clientX: 800, clientY: 50 }), canvas, 640, 400)).toEqual({ x: 639, y: 0 });
  });

  it('pipelines a bounded number of events and coalesces only consecutive queued moves', async () => {
    const sent: TaskAppInput[] = [], release: (() => void)[] = [];
    const lane = new AppInputQueue(event => { sent.push(event); return new Promise<void>(r => release.push(r)); }, vi.fn());
    const move = (x: number) => lane.push({ kind: 'move', x, y: 0 });
    for (let x = 0; x <= 8; x++) move(x);
    lane.push({ kind: 'up', x: 8, y: 0, button: 0 });
    move(9);
    expect(sent.length).toBe(4);
    release.splice(0).forEach(resolve => resolve());
    await vi.waitFor(() => expect(sent.length).toBe(7));
    expect(sent.slice(4)).toEqual([{ kind: 'move', x: 8, y: 0 }, { kind: 'up', x: 8, y: 0, button: 0 }, { kind: 'move', x: 9, y: 0 }]);
    release.splice(0).forEach(resolve => resolve());
  });
});
