import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AddMachineComponent } from './add-machine.component';
import { MachineHomeComponent } from './machine-home.component';
import { MachineCardComponent } from './machine-card.component';
import { MACHINE_LAUNCH_OPEN } from './machine-launch-context';
import { Machine } from './machine.models';

@Component({ imports: [MachineHomeComponent], providers: [{ provide: MACHINE_LAUNCH_OPEN, useFactory: () => launched }], template: '<ex-machine-home [machines]="machines()" [pending]="pending()" />' })
class HomeHost {
  readonly machines = signal<readonly Machine[]>([{ id: 'local', name: 'This Mac', kind: 'local', conn: 'live' }, { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'idle' }]);
  readonly pending = signal<string | null>(null);
}
const launched = signal(false);

describe('Machine onboarding', () => {
  beforeEach(() => {
    launched.set(false);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  it('asks where agents run on first run, and returns the actual dashed card as the dialog origin', () => {
    const fixture = TestBed.createComponent(MachineHomeComponent);
    fixture.componentRef.setInput('firstRun', true);
    fixture.componentRef.setInput('machines', [{ id: 'local', name: 'This Mac', kind: 'local', conn: 'idle', busy: { step: 'Downloading' } }]);
    fixture.detectChanges();
    const add = vi.fn(); fixture.componentInstance.addServer.subscribe(add);
    const card = fixture.nativeElement.querySelector('ex-machine-add button') as HTMLButtonElement;
    expect(fixture.nativeElement.querySelector('h1').textContent).toBe('Where should your agents run?');
    expect(fixture.nativeElement.querySelector('footer')).toBeNull();
    expect(fixture.nativeElement.querySelector('h2')).toBeNull();
    card.click(); expect(add).toHaveBeenCalledExactlyOnceWith(card);
  });

  it('keeps the same card and group throughout preparation, pending readiness and an open machine', () => {
    const fixture = TestBed.createComponent(HomeHost); fixture.detectChanges();
    const dev = fixture.nativeElement.querySelector('[data-machine="dev"]');
    const order = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('h2, [data-machine]')).map(node => node.dataset['machine'] ?? node.textContent?.trim());
    const initial = order();
    fixture.componentInstance.pending.set('dev');
    fixture.componentInstance.machines.update(machines => machines.map(machine => machine.id === 'dev' ? { ...machine, conn: 'live', busy: { step: 'Starting' } } : machine));
    fixture.detectChanges(); expect(order()).toEqual(initial);
    fixture.componentInstance.machines.update(machines => machines.map(machine => ({ ...machine, busy: undefined })));
    fixture.detectChanges(); expect(order()).toEqual(initial);
    launched.set(true); fixture.componentInstance.pending.set(null); fixture.detectChanges(); expect(order()).toEqual(initial);
    launched.set(false); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('h2')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('[data-machine="dev"]')).toBe(dev);
  });

  it('renders busy progress and a pending tag, replaces step ink only on step changes, and settles only after preparation', () => {
    const fixture = TestBed.createComponent(MachineCardComponent);
    const machine = { id: 'local', name: 'This Mac', kind: 'local', conn: 'idle' };
    fixture.componentRef.setInput('machine', machine); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.presence.settled')).toBeNull();
    fixture.componentRef.setInput('machine', { ...machine, busy: { step: 'Downloading', meta: '42%', progress: .42 } });
    fixture.componentRef.setInput('pending', true); fixture.detectChanges();
    const ink = fixture.nativeElement.querySelector('.description > span');
    expect(fixture.nativeElement.textContent).toContain('Will open');
    expect(fixture.nativeElement.querySelector('button').getAttribute('aria-busy')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('42');
    fixture.componentRef.setInput('machine', { ...machine, busy: { step: 'Downloading', meta: '58%', progress: .58 } }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.description > span')).toBe(ink);
    fixture.componentRef.setInput('machine', { ...machine, conn: 'live', status: 'Ready to work' }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.presence.settled')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Ready to work');
  });

  it('makes an error card one named action, falls back to opening, and preserves the stopped progress', () => {
    const fixture = TestBed.createComponent(MachineCardComponent);
    const machine: Machine = { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'fail', error: { step: 'Key not accepted for leo', progress: .38 } };
    fixture.componentRef.setInput('machine', machine); fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    const opened = vi.fn(), action = vi.fn(); fixture.componentInstance.opened.subscribe(opened);
    expect(card.getAttribute('aria-label')).toBe('dev-box. Key not accepted for leo. Try again');
    expect(card.querySelector('button')).toBeNull();
    expect(card.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('38');
    card.click(); expect(opened).toHaveBeenCalledExactlyOnceWith({ machine, newWindow: false });
    const subscription = fixture.componentInstance.actionRequested.subscribe(action);
    card.dispatchEvent(new MouseEvent('click', { ctrlKey: true }));
    expect(action).toHaveBeenCalledExactlyOnceWith({ machine, newWindow: true }); expect(opened).toHaveBeenCalledTimes(1);
    subscription.unsubscribe(); card.click(); expect(opened).toHaveBeenCalledTimes(2);
  });

  it('shakes once after preparation fails, keeps initial failures still, and cancels on retry or reduced motion', () => {
    let motionChanged = () => undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn((_name: string, listener: () => undefined) => { motionChanged = listener; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', () => media);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    try {
      const fixture = TestBed.createComponent(MachineCardComponent);
      const failed: Machine = { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'fail', error: { step: 'Connection failed' } };
      const preparing: Machine = { ...failed, error: undefined, conn: 'idle', busy: { step: 'Connecting' } };
      fixture.componentRef.setInput('machine', failed); fixture.detectChanges();
      expect(animate).not.toHaveBeenCalled();
      fixture.componentRef.setInput('machine', preparing); fixture.detectChanges();
      fixture.componentRef.setInput('machine', failed); fixture.detectChanges();
      expect(animate).toHaveBeenCalledOnce();
      fixture.componentRef.setInput('machine', { ...failed, error: { step: 'Check your connection' } }); fixture.detectChanges();
      expect(animate).toHaveBeenCalledOnce();
      fixture.componentRef.setInput('machine', preparing); fixture.detectChanges();
      expect(cancel).toHaveBeenCalledOnce();
      fixture.componentRef.setInput('machine', failed); fixture.detectChanges();
      expect(animate).toHaveBeenCalledTimes(2);
      media.matches = true; motionChanged();
      expect(cancel).toHaveBeenCalledTimes(2);
      fixture.componentRef.setInput('machine', preparing); fixture.detectChanges();
      fixture.componentRef.setInput('machine', failed); fixture.detectChanges();
      expect(animate).toHaveBeenCalledTimes(2);
      fixture.destroy();
      expect(media.removeEventListener).toHaveBeenCalledWith('change', motionChanged);
    } finally {
      TestBed.resetTestingModule();
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'animate', descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('opens Find from its pill and shortcut, and closes it with Escape', () => {
    const fixture = TestBed.createComponent(MachineHomeComponent); fixture.detectChanges();
    const requested = vi.fn(); fixture.componentInstance.findRequested.subscribe(requested);
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    fixture.nativeElement.querySelector('.find').click(); fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input); expect(requested).toHaveBeenCalledOnce();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    fixture.nativeElement.querySelector('section').dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true, cancelable: true })); fixture.detectChanges();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('input')); expect(requested).toHaveBeenCalledTimes(2);
  });

  it('emits host-key lookup separately from confirmation, with one shared footer and stable primary action', () => {
    const fixture = TestBed.createComponent(AddMachineComponent);
    const host = { name: 'dev-box', user: 'leo' };
    fixture.componentRef.setInput('kind', 'ssh'); fixture.componentRef.setInput('picked', host); fixture.detectChanges();
    const keyRequested = vi.fn(), confirmed = vi.fn(); fixture.componentInstance.keyRequested.subscribe(keyRequested); fixture.componentInstance.confirmed.subscribe(confirmed);
    const primary = fixture.nativeElement.querySelector('footer button:last-child') as HTMLButtonElement;
    primary.click(); expect(keyRequested).toHaveBeenCalledExactlyOnceWith(host); expect(confirmed).not.toHaveBeenCalled();
    fixture.componentRef.setInput('step', 'key'); fixture.detectChanges(); expect(primary.disabled).toBe(true);
    fixture.componentRef.setInput('fingerprint', 'SHA256:test'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('footer button:last-child')).toBe(primary);
    expect(fixture.nativeElement.querySelectorAll('footer')).toHaveLength(1);
    primary.click(); expect(confirmed).toHaveBeenCalledExactlyOnceWith({ kind: 'ssh', host, fingerprint: 'SHA256:test', keyType: 'ED25519', replaced: false });
  });

  it('uses Enter to select an SSH host without also advancing; ignores composition and preserves textarea newlines', () => {
    const fixture = TestBed.createComponent(AddMachineComponent);
    fixture.componentRef.setInput('kind', 'ssh'); fixture.componentRef.setInput('hosts', [{ id: 'dev', name: 'dev-box', detail: 'leo@dev' }]); fixture.detectChanges();
    const selected = vi.fn(), keyRequested = vi.fn(); fixture.componentInstance.hostSelected.subscribe(selected); fixture.componentInstance.keyRequested.subscribe(keyRequested);
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(selected).toHaveBeenCalledOnce(); expect(keyRequested).not.toHaveBeenCalled();
    fixture.componentRef.setInput('kind', 'peer'); fixture.componentRef.setInput('found', { id: 'peer', name: 'Mini', detail: 'On your network' }); fixture.componentRef.setInput('text', 'text'); fixture.detectChanges();
    const confirmed = vi.fn(); fixture.componentInstance.confirmed.subscribe(confirmed);
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false); expect(confirmed).not.toHaveBeenCalled();
  });

  it('invalidates changed-key confirmation when the supplied server identity changes', () => {
    const fixture = TestBed.createComponent(AddMachineComponent);
    for (const [key, value] of Object.entries({ kind: 'ssh', step: 'key', picked: { name: 'dev', user: 'leo' }, fingerprint: 'SHA256:first', keyChanged: true })) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    const primary = fixture.nativeElement.querySelector('footer button:last-child') as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    const confirm = fixture.nativeElement.querySelector('ex-host-key-check button') as HTMLButtonElement;
    confirm.click(); fixture.detectChanges(); expect(primary.disabled).toBe(false);
    fixture.componentRef.setInput('fingerprint', 'SHA256:second'); fixture.detectChanges(); expect(primary.disabled).toBe(true);
    const confirmed = vi.fn(); fixture.componentInstance.confirmed.subscribe(confirmed); primary.click(); expect(confirmed).not.toHaveBeenCalled();
  });
});
