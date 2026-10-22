import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IslandEventComponent } from './island-event.component';
import { TitleIslandComponent } from './title-island.component';

@Component({
  imports: [TitleIslandComponent, IslandEventComponent],
  template: `
    <ex-title-island label="This Mac details" controls="test-machine-details" [contentKey]="key()" [open]="open()" [panel]="details" (pressed)="open.set(true)" (dismissed)="open.set(false)">
      <ex-island-event title="A computer connected" action="Disconnect" (actionRequested)="disconnected.set(true)" />
    </ex-title-island>
    <ng-template #details><button type="button">Change machine</button></ng-template>
    <button class="outside" type="button">Outside</button>
  `,
})
class IslandHost {
  readonly open = signal(false);
  readonly key = signal('name');
  readonly disconnected = signal(false);
}

describe('Title island interaction ownership', () => {
  const removeMotionListener = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: removeMotionListener }));
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('mounts details only when open and restores the resting trigger on dismissal', async () => {
    const fixture = TestBed.createComponent(IslandHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    const trigger = host.querySelector<HTMLButtonElement>('.trigger')!;
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    trigger.focus();
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.id).toBe('test-machine-details');
    // JSDOM has no layout for CDK's visibility checks; native captures verify
    // automatic focus and tab trapping in the real renderer.
    dialog.querySelector<HTMLButtonElement>('button')!.focus();
    expect(trigger.hidden).toBe(true);
    expect(host.querySelector('.summary')?.hasAttribute('inert')).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.hidden).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps event actions independent of the machine trigger and dismisses on outside input', async () => {
    const fixture = TestBed.createComponent(IslandHost);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    host.querySelector<HTMLButtonElement>('ex-island-event button')!.click();
    expect(fixture.componentInstance.disconnected()).toBe(true);
    expect(fixture.componentInstance.open()).toBe(false);
    host.querySelector<HTMLButtonElement>('.trigger')!.click();
    fixture.detectChanges();
    host.querySelector('.outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    fixture.destroy();
    expect(removeMotionListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('bounds progress including non-finite replies', () => {
    const fixture = TestBed.createComponent(TitleIslandComponent);
    for (const [value, expected] of [[-1, '0'], [2, '100'], [Number.NaN, '0'], [Infinity, '0']]) {
      fixture.componentRef.setInput('progress', value);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe(expected);
    }
  });
});
