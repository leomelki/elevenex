import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MachineLaunchComponent } from './machine-launch.component';
import { measureLaunchRect } from './machine-launch-motion';

@Component({
  imports: [MachineLaunchComponent],
  template: `<ex-machine-launch [open]="open()" (transitionFinished)="finished.set($event)">
    <button machineHome type="button">Home</button>
    <div machineView><button type="button">First</button><button type="button">Second</button></div>
  </ex-machine-launch>`,
})
class LaunchHost {
  readonly open = signal(false);
  readonly finished = signal<boolean | undefined>(undefined);
}

describe('Machine launch interaction ownership', () => {
  it('measures the painted card in unscaled host coordinates', () => {
    const host = document.createElement('div'), card = document.createElement('button');
    Object.defineProperty(host, 'offsetWidth', { value: 500 });
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 1000, 800));
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(110, 80, 320, 240));
    expect(measureLaunchRect(host, card)).toEqual({ left: 50, top: 30, width: 160, height: 120 });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });

  it('finishes movement when reduced motion changes without stealing destination focus', async () => {
    let changed: (() => void) | undefined;
    const media = {
      matches: false,
      addEventListener: (_name: string, listener: () => void) => { changed = listener; },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', () => media);
    const fixture = TestBed.createComponent(LaunchHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const pane = fixture.nativeElement.querySelector('.pane') as HTMLElement;
    expect(pane.querySelector('button')?.closest('[inert]')).not.toBeNull();
    let complete: (() => void) | undefined;
    const finished = new Promise<void>(resolve => { complete = resolve; });
    const finish = vi.fn(() => complete?.());
    const cancel = vi.fn();
    const animation = { finished, finish, cancel };
    const animate = vi.fn<(frames: Keyframe[]) => typeof animation>(() => animation);
    Object.defineProperty(pane, 'animate', { value: animate });

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(document.activeElement).toBe(pane.querySelector('button')));
    expect(pane.querySelector('button')?.closest('[inert]')).toBeNull();
    const second = pane.querySelectorAll('button')[1]!;
    second.focus();
    media.matches = true;
    changed?.();
    await finished;
    await fixture.whenStable();
    expect(finish).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(second);
    await vi.waitFor(() => expect(fixture.componentInstance.finished()).toBe(true));

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate.mock.calls.at(-1)?.[0]).toEqual([
      { opacity: 1 },
      { opacity: 0 },
    ]);
    fixture.destroy();
    expect(cancel).toHaveBeenCalled();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changed);
  });
});
