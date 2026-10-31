import { TestBed } from '@angular/core/testing';
import { MachineCardComponent } from './machine-card.component';
import { MachineMenuComponent } from './machine-menu.component';
import { EditMachineComponent } from './edit-machine.component';
import { MachineHomeComponent } from './machine-home.component';
import { ToastComponent } from '../ui';

const server = { id: 'dev', name: 'dev-box', kind: 'ssh' as const, conn: 'idle' as const, host: 'dev', user: 'leo', port: 2222, hue: 'ocean' as const };

describe('Machine editing controls', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })));
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('keeps menu and card actions siblings, returns the card and distinguishes context/button origins', () => {
    const fixture = TestBed.createComponent(MachineCardComponent), menu = vi.fn(), open = vi.fn();
    fixture.componentRef.setInput('machine', server);
    fixture.componentInstance.menuRequested.subscribe(menu); fixture.componentInstance.opened.subscribe(open); fixture.detectChanges();
    const card: HTMLButtonElement = fixture.nativeElement.querySelector('[data-machine]');
    expect(card.querySelector('button')).toBeNull();
    fixture.nativeElement.querySelector('.more').click();
    expect(menu).toHaveBeenLastCalledWith(expect.objectContaining({ machine: server, card, fromButton: true }));
    card.dispatchEvent(new MouseEvent('contextmenu', { clientX: 60, clientY: 80, bubbles: true, cancelable: true }));
    expect(menu).toHaveBeenLastCalledWith(expect.objectContaining({ card, x: 60, y: 80, fromButton: false }));
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    expect(menu).toHaveBeenCalledTimes(3); expect(open).not.toHaveBeenCalled();
    fixture.componentRef.setInput('disabled', true); fixture.detectChanges(); card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    expect(menu).toHaveBeenCalledTimes(3);
  });

  it('omits local removal/disconnect and labels peers and occupied machines correctly', () => {
    const fixture = TestBed.createComponent(MachineMenuComponent);
    fixture.componentRef.setInput('machine', { ...server, kind: 'local', conn: 'live' }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('button')).toHaveLength(2);
    fixture.componentRef.setInput('machine', { ...server, kind: 'peer', conn: 'live', windows: 2 }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Disconnect'); expect(fixture.nativeElement.textContent).toContain('Unpair…');
    fixture.componentRef.setInput('machine', server); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Disconnect'); expect(fixture.nativeElement.textContent).not.toContain('Remove…');
  });

  it('offers error details only for a failed machine with a diagnostic', () => {
    const fixture = TestBed.createComponent(MachineMenuComponent), action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    fixture.componentRef.setInput('machine', { ...server, conn: 'fail', last: 'Bootstrap failed', error: { step: 'Bootstrap failed' } });
    fixture.detectChanges();
    const details = fixture.nativeElement.querySelector('button');
    expect(details.textContent).toContain('View error details');
    details.click(); expect(action).toHaveBeenCalledWith('details');
    fixture.componentRef.setInput('machine', server); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('View error details');
  });

  it('waits for a held right-click to finish and releases its pending listener on disposal', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(MachineCardComponent), menu = vi.fn();
    fixture.componentRef.setInput('machine', server); fixture.componentInstance.menuRequested.subscribe(menu); fixture.detectChanges();
    const card: HTMLButtonElement = fixture.nativeElement.querySelector('[data-machine]');
    card.dispatchEvent(new MouseEvent('contextmenu', { buttons: 2, bubbles: true, cancelable: true }));
    expect(menu).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('pointerup')); await vi.advanceTimersByTimeAsync(0);
    expect(menu).toHaveBeenCalledOnce();
    card.dispatchEvent(new MouseEvent('contextmenu', { buttons: 2, bubbles: true, cancelable: true })); fixture.destroy();
    document.dispatchEvent(new Event('pointerup')); await vi.advanceTimersByTimeAsync(0); expect(menu).toHaveBeenCalledOnce();
  });

  it('preserves a draft, warns on destination edits and validates port/name before emitting Save', () => {
    const fixture = TestBed.createComponent(EditMachineComponent), save = vi.fn();
    fixture.componentRef.setInput('machine', server); fixture.componentInstance.saved.subscribe(save); fixture.detectChanges();
    const edit = (label: string, value: string) => {
      const button = Array.from(fixture.nativeElement.querySelectorAll('ex-set-value button')) as HTMLButtonElement[];
      button.find(item => item.getAttribute('aria-label')?.startsWith(label + ':'))!.click(); fixture.detectChanges();
      const input: HTMLInputElement = fixture.nativeElement.querySelector('input'); input.value = value; input.dispatchEvent(new Event('input')); fixture.detectChanges(); input.dispatchEvent(new Event('blur')); fixture.detectChanges();
    };
    edit('Host', 'staging.internal');
    expect(fixture.nativeElement.textContent).toContain('Saving reconnects');
    edit('Port', '65536');
    expect(fixture.nativeElement.querySelector('button[type=submit]').disabled).toBe(true);
    edit('Port', '2200'); edit('Name', 'Staging');
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(save).toHaveBeenCalledWith({ name: 'Staging', hue: 'ocean', host: 'staging.internal', user: 'leo', port: 2200, key: 'default' });
    fixture.componentRef.setInput('disabled', true); fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); expect(save).toHaveBeenCalledOnce();
  });

  it('asks only for occupied removal and keeps local editing limited to name/color', () => {
    const fixture = TestBed.createComponent(EditMachineComponent), remove = vi.fn();
    fixture.componentRef.setInput('machine', { ...server, windows: 2 }); fixture.componentInstance.removeRequested.subscribe(remove); fixture.detectChanges();
    fixture.nativeElement.querySelector('.remove').click(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('2 windows are on it'); expect(remove).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('footer button:last-child').click(); expect(remove).toHaveBeenCalledOnce();
    fixture.destroy();
    const local = TestBed.createComponent(EditMachineComponent); local.componentRef.setInput('machine', { ...server, kind: 'local' }); local.detectChanges();
    expect(local.nativeElement.querySelectorAll('ex-set-value')).toHaveLength(1); expect(local.nativeElement.querySelector('.remove')).toBeNull();
  });

  it('retains a departing card inert for its fade and cancels removal when Undo restores its identity', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(MachineHomeComponent); fixture.componentRef.setInput('machines', [server]); fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('[data-machine]');
    fixture.componentRef.setInput('machines', []); fixture.detectChanges();
    expect(card.closest('[inert]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(100); fixture.componentRef.setInput('machines', [server]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-machine]')).toBe(card); expect(card.closest('[inert]')).toBeNull();
    await vi.advanceTimersByTimeAsync(300); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-machine]')).toBe(card);
    fixture.componentRef.setInput('machines', []); fixture.detectChanges(); await vi.advanceTimersByTimeAsync(260); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[data-machine]')).toBeNull();
  });

  it('runs the Toast action once, closes it and pauses expiry while focused', async () => {
    vi.useFakeTimers(); const fixture = TestBed.createComponent(ToastComponent), action = vi.fn(), close = vi.fn();
    fixture.componentRef.setInput('title', 'Removed dev-box'); fixture.componentRef.setInput('action', 'Undo'); fixture.componentRef.setInput('duration', 5000);
    fixture.componentInstance.actionSelected.subscribe(action); fixture.componentInstance.dismissed.subscribe(close); fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    button.focus(); await vi.advanceTimersByTimeAsync(6000); expect(close).not.toHaveBeenCalled();
    button.click(); expect(action).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(6000); expect(close).toHaveBeenCalledOnce();
  });
});
