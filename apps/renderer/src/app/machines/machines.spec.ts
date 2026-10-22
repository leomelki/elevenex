import { TestBed } from '@angular/core/testing';
import { HostKeyCheckComponent } from './host-key-check.component';
import { MachineCardComponent } from './machine-card.component';
import { PairPasteComponent } from './pair-paste.component';
import { stagedSteps } from './machine.models';

describe('Machine presentation boundaries', () => {
  it('requires typed confirmation for a changed key and invalidates it when the fingerprint changes', () => {
    const fixture = TestBed.createComponent(HostKeyCheckComponent);
    fixture.componentRef.setInput('host', 'dev-box');
    fixture.componentRef.setInput('fingerprint', 'SHA256:first');
    fixture.componentRef.setInput('changed', true);
    fixture.detectChanges();
    const trusted = vi.fn();
    fixture.componentInstance.trusted.subscribe(trusted);
    const button = fixture.nativeElement.querySelector('footer button') as HTMLButtonElement;
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(button.disabled).toBe(true);
    input.value = 'dev-box';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    fixture.componentRef.setInput('fingerprint', 'SHA256:replacement');
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    button.click();
    expect(trusted).not.toHaveBeenCalled();
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button.click();
    expect(trusted).toHaveBeenCalledWith({ host: 'dev-box', fingerprint: 'SHA256:replacement', replaced: true });
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
    const fixture = TestBed.createComponent(PairPasteComponent);
    fixture.componentRef.setInput('text', 'pairing-text');
    fixture.componentRef.setInput('found', { id: 'peer', name: 'Studio Mac', detail: 'On your network' });
    fixture.componentRef.setInput('finding', true);
    fixture.detectChanges();
    const paired = vi.fn();
    fixture.componentInstance.paired.subscribe(paired);
    const button = fixture.nativeElement.querySelector('footer button') as HTMLButtonElement;
    button.click();
    expect(paired).not.toHaveBeenCalled();
    fixture.componentRef.setInput('finding', false);
    fixture.componentRef.setInput('error', 'Pairing text expired');
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    fixture.componentRef.setInput('error', '');
    fixture.detectChanges();
    button.click();
    expect(paired).toHaveBeenCalledWith({ id: 'peer', name: 'Studio Mac', detail: 'On your network' });
  });

  it('clamps overall progress and advances only the current readiness step', () => {
    expect(stagedSteps(.5, [.25, .75, 1])).toEqual(['done', 'active', 'todo']);
    expect(stagedSteps(2, [.25, 1])).toEqual(['done', 'done']);
    expect(stagedSteps(Number.NaN, [.25, 1])).toEqual(['active', 'todo']);
  });
});
