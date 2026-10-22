import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MachineLaunchComponent } from './machine-launch.component';

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
    const second = pane.querySelectorAll('button')[1]!;
    second.focus();
    media.matches = true;
    changed?.();
    await finished;
    await fixture.whenStable();
    expect(finish).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(second);
    expect(fixture.componentInstance.finished()).toBe(true);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(animate.mock.calls.at(-1)?.[0]).toEqual([
      { opacity: 1, visibility: 'visible' },
      { opacity: 0, visibility: 'visible' },
    ]);
    fixture.destroy();
    expect(cancel).toHaveBeenCalled();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', changed);
  });
});
