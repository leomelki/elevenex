import { TestBed } from '@angular/core/testing';
import { HostKeyCheckComponent } from './host-key-check.component';
import { HostFieldComponent } from './host-field.component';
import { MachineCardComponent } from './machine-card.component';
import { MachinePanelComponent } from './machine-panel.component';
import { AddMachineComponent } from './add-machine.component';
import { stagedSteps } from './machine.models';

describe('Machine presentation boundaries', () => {
  it('keeps the island panel actions distinct and disables them together while pending', () => {
    const fixture = TestBed.createComponent(MachinePanelComponent);
    const guest = { id: 'peer', name: 'Studio Mac', since: '10:42' };
    fixture.componentRef.setInput('machine', { id: 'remote', name: 'Dev box', kind: 'ssh', conn: 'live' });
    fixture.componentRef.setInput('guests', [guest]);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    const changed = vi.fn(), disconnected = vi.fn(), guestDisconnected = vi.fn(), newWindow = vi.fn();
    fixture.componentInstance.changeRequested.subscribe(changed);
    fixture.componentInstance.disconnectRequested.subscribe(disconnected);
    fixture.componentInstance.guestDisconnected.subscribe(guestDisconnected);
    fixture.componentInstance.newWindow.subscribe(newWindow);
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons).toHaveLength(4);
    for (const button of buttons) { expect(button.disabled).toBe(true); button.click(); }
    for (const action of [changed, disconnected, guestDisconnected, newWindow]) expect(action).not.toHaveBeenCalled();
    fixture.componentRef.setInput('disabled', false);
    fixture.detectChanges();
    for (const button of buttons) button.click();
    expect(changed).toHaveBeenCalledOnce();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(guestDisconnected).toHaveBeenCalledExactlyOnceWith(guest);
    expect(newWindow).toHaveBeenCalledOnce();
  });

  it('requires typed confirmation for a changed key and invalidates it when the fingerprint changes', () => {
    const fixture = TestBed.createComponent(HostKeyCheckComponent);
    fixture.componentRef.setInput('host', 'dev-box');
    fixture.componentRef.setInput('fingerprint', 'SHA256:first');
    fixture.componentRef.setInput('changed', true);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(fixture.componentInstance.canTrust()).toBe(false);
    input.value = 'dev-box';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.canTrust()).toBe(true);
    fixture.componentRef.setInput('fingerprint', 'SHA256:replacement');
    fixture.detectChanges();
    expect(fixture.componentInstance.canTrust()).toBe(false);
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.canTrust()).toBe(true);
  });

  it('keeps a keyboard destination when the machine panel actions become disabled', async () => {
    const fixture = TestBed.createComponent(MachinePanelComponent);
    fixture.componentRef.setInput('machine', { id: 'local', name: 'This Mac', kind: 'local', conn: 'live' });
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    host.querySelector<HTMLButtonElement>('button')!.focus();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    await fixture.whenStable();
    const panel = host.querySelector<HTMLElement>('.panel')!;
    expect(panel.tabIndex).toBe(0);
    expect(document.activeElement).toBe(panel);
    fixture.componentRef.setInput('disabled', false);
    fixture.detectChanges();
    expect(panel.hasAttribute('tabindex')).toBe(false);
  });

  it('shows dated history instead of live status for a disconnected machine and supports a new-window intent', () => {
    const fixture = TestBed.createComponent(MachineCardComponent);
    fixture.componentRef.setInput('machine', { id: 'remote', name: 'Dev box', kind: 'ssh', conn: 'idle', status: '9 running', last: 'Opened 2 h ago' });
    fixture.detectChanges();
    const opened = vi.fn();
    fixture.componentInstance.opened.subscribe(opened);
    expect(fixture.nativeElement.textContent).toContain('Opened 2 h ago');
    expect(fixture.nativeElement.textContent).not.toContain('9 running');
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { metaKey: true }));
    expect(opened.mock.calls[0]?.[0].newWindow).toBe(true);
  });

  it('cannot pair while discovery is pending or reports an error', () => {
    const fixture = TestBed.createComponent(AddMachineComponent);
    fixture.componentRef.setInput('kind', 'peer');
    fixture.componentRef.setInput('text', 'pairing-text');
    fixture.componentRef.setInput('found', { id: 'peer', name: 'Studio Mac', detail: 'On your network' });
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    const paired = vi.fn();
    fixture.componentInstance.confirmed.subscribe(paired);
    const button = fixture.nativeElement.querySelector('footer button:last-child') as HTMLButtonElement;
    button.click();
    expect(paired).not.toHaveBeenCalled();
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('error', 'Pairing text expired');
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    fixture.componentRef.setInput('error', '');
    fixture.detectChanges();
    button.click();
    expect(paired).toHaveBeenCalledWith({ kind: 'peer', text: 'pairing-text', computer: { id: 'peer', name: 'Studio Mac', detail: 'On your network' } });
  });

  it('opens a machine in a new window with Command or Control Enter', () => {
    const fixture = TestBed.createComponent(MachineCardComponent);
    const machine = { id: 'remote', name: 'Dev box', kind: 'ssh', conn: 'idle' };
    fixture.componentRef.setInput('machine', machine);
    fixture.detectChanges();
    const opened = vi.fn();
    fixture.componentInstance.opened.subscribe(opened);
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...modifiers });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenLastCalledWith({ machine, newWindow: true });
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it('does not select an SSH suggestion from a resolved field or an unfinished composition', () => {
    const fixture = TestBed.createComponent(HostFieldComponent);
    const host = { id: 'dev', name: 'dev-box', detail: 'leo@dev.internal' };
    fixture.componentRef.setInput('hosts', [host]);
    fixture.componentRef.setInput('picked', { name: host.name, user: 'leo' });
    fixture.detectChanges();
    const selected = vi.fn();
    fixture.componentInstance.selected.subscribe(selected);
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(selected).not.toHaveBeenCalled();
    fixture.componentRef.setInput('picked', null);
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(selected).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(selected).toHaveBeenCalledExactlyOnceWith(host);
  });

  it('clamps overall progress and advances only the current readiness step', () => {
    expect(stagedSteps(.5, [.25, .75, 1])).toEqual(['done', 'active', 'todo']);
    expect(stagedSteps(2, [.25, 1])).toEqual(['done', 'done']);
    expect(stagedSteps(Number.NaN, [.25, 1])).toEqual(['active', 'todo']);
  });
});
