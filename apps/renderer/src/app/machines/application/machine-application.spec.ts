import { TestBed } from '@angular/core/testing';
import type { MachineState } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../../backend/backend-client.service';
import { MachineStartupFixture } from '../../../../preview/machine-startup-fixture';
import { MachineConnectionService } from './machine-connection.service';
import { MachineLauncherService } from './machine-launcher.service';
import { MachineActionsService } from './machine-actions.service';
import { SshSetupService } from './ssh-setup.service';
import { machineHomeStatus } from '../machine-home-status';
import { remotePresentation, parseSshDestination } from './machine-presentation';
import { RemoteChallengeDialogComponent } from './remote-challenge-dialog.component';

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); TestBed.tick(); }
function setup() {
  TestBed.configureTestingModule({ providers: [MachineStartupFixture, MachineConnectionService, MachineLauncherService, MachineActionsService, SshSetupService, BackendClientService, { provide: ELEVENEX_BRIDGE, useExisting: MachineStartupFixture }] });
  return { platform: TestBed.inject(MachineStartupFixture), connection: TestBed.inject(MachineConnectionService), launcher: TestBed.inject(MachineLauncherService) };
}

describe('Production machine application', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  for (const fromMenu of [false, true]) it(`cancels a settling launch when disconnected ${fromMenu ? 'through its menu' : 'by another window'}`, async () => {
    const { platform, launcher, connection } = setup(), actions = TestBed.inject(MachineActionsService); await flush();
    const host = await connection.addHost({ name: 'Dev', host: 'dev' });
    await launcher.choose(host.id); platform.ready(); await flush(); expect(launcher.pendingId()).toBe(host.id);
    if (fromMenu) await actions.act({ action: 'disconnect', event: { machine: actions.machines().find(machine => machine.id === host.id)!, card: document.createElement('button'), x: 0, y: 0, fromButton: true } });
    else await platform.disconnectRemote();
    await flush(); await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(launcher.pendingId()).toBeNull(); expect(launcher.open()).toBe(false); expect(launcher.error()).toBe('');
    await launcher.choose(host.id); await flush(); expect(launcher.pendingId()).toBe(host.id);
  });

  it('edits appearance without connecting, checks a changed host on Home, removes and restores its original identity', async () => {
    const { platform, launcher, connection } = setup(), actions = TestBed.inject(MachineActionsService); await flush();
    const host = await connection.addHost({ name: 'Dev', host: 'dev', identityFile: '/fixture/saved-key' }); await flush();
    const openEditor = async () => {
      const machine = actions.machines().find(machine => machine.id === host.id)!;
      await actions.act({ action: 'edit', event: { machine, card: document.createElement('button'), x: 0, y: 0, fromButton: true } });
    };
    await openEditor();
    const select = vi.spyOn(platform, 'selectEnvironment');
    await actions.save({ name: 'Build', hue: 'rose', host: 'dev' }); await flush();
    expect(select).not.toHaveBeenCalled(); expect((await platform.machineState()).hosts[0]?.identityFile).toBe('/fixture/saved-key');
    expect(actions.machines().find(machine => machine.id === host.id)?.hue).toBe('rose');
    await openEditor(); await actions.save({ name: 'Build', hue: 'rose', host: 'build', port: 2200 }); await flush();
    expect(select).toHaveBeenCalledOnce(); expect(launcher.pendingId()).toBeNull(); expect(launcher.open()).toBe(false);
    expect(actions.machines().find(machine => machine.id === host.id)?.busy).toBeDefined();
    const machine = actions.machines().find(machine => machine.id === host.id)!;
    await actions.act({ action: 'remove', event: { machine, card: document.createElement('button'), x: 0, y: 0, fromButton: false } });
    expect(actions.editOpen()).toBe(true); await actions.removeDraft(); await flush();
    expect(actions.machines().some(machine => machine.id === host.id)).toBe(false);
    const token = actions.notices()[0]!.id;
    const undo = actions.undo(token); actions.dismiss(token); await undo; await flush();
    expect(actions.machines()[1]?.id).toBe(host.id); expect(actions.machines()[1]?.conn).toBe('idle'); expect(actions.notices()).toEqual([]);
  });

  it('rolls a failed optimistic removal back and retains the edit draft after a rejected save', async () => {
    const { platform, connection } = setup(), actions = TestBed.inject(MachineActionsService); await flush();
    const host = await connection.addHost({ name: 'Dev', host: 'dev' }); await flush();
    const event = { machine: actions.machines().find(machine => machine.id === host.id)!, card: document.createElement('button'), x: 0, y: 0, fromButton: true };
    vi.spyOn(platform, 'removeMachine').mockRejectedValue(new Error('Write failed'));
    await actions.act({ event, action: 'remove' }); await flush();
    expect(actions.machines().some(machine => machine.id === host.id)).toBe(true); expect(actions.notices()).toEqual([]);
    await actions.act({ event, action: 'edit' }); vi.spyOn(platform, 'editMachine').mockRejectedValue(new Error('Write failed'));
    await actions.save({ name: 'Changed', hue: 'pine', host: 'dev' }); await flush();
    expect(actions.editOpen()).toBe(true); expect(actions.error()).not.toBe(''); expect(actions.saving()).toBe(false);
  });

  it('does not let a bootstrap read replace a newer lifecycle event, and unsubscribes on disposal', async () => {
    TestBed.configureTestingModule({ providers: [MachineStartupFixture, MachineConnectionService, { provide: ELEVENEX_BRIDGE, useExisting: MachineStartupFixture }] });
    const platform = TestBed.inject(MachineStartupFixture);
    const initial = await platform.machineState();
    let resolve!: (state: MachineState) => void;
    vi.spyOn(platform, 'machineState').mockImplementation(() => new Promise(done => { resolve = done; }));
    const stop = vi.fn(); const subscribe = platform.onMachineStateChanged;
    vi.spyOn(platform, 'onMachineStateChanged').mockImplementation(listener => { const unsubscribe = subscribe(listener); return () => { stop(); unsubscribe(); }; });
    const connection = TestBed.inject(MachineConnectionService);
    platform.ready(); resolve(initial); await flush();
    expect(connection.state()?.localBackend.phase).toBe('ready');
    TestBed.resetTestingModule(); platform.fail();
    expect(stop).toHaveBeenCalledOnce(); expect(connection.state()?.localBackend.phase).toBe('ready');
  });

  it('waits for preparation to settle, persists only after opening and returns to the same Home', async () => {
    const { platform, launcher } = setup(); await flush();
    await launcher.choose('local'); await flush();
    expect(launcher.firstRun()).toBe(true); expect(launcher.open()).toBe(false);
    platform.ready(); await flush();
    await launcher.choose('local'); // Repeated clicks coalesce during the settling beat.
    await vi.advanceTimersByTimeAsync(449); expect(launcher.open()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(launcher.open()).toBe(true); expect(launcher.firstRun()).toBe(false);
    expect((await platform.machineState()).hasOpenedMachine).toBe(true);
    launcher.home(); await flush();
    expect(launcher.open()).toBe(false); expect(launcher.machines()[0]?.conn).toBe('live');
  });

  it('cancels pending opening on navigation, failure and destruction', async () => {
    const { platform, launcher } = setup(); await flush();
    await launcher.choose('local'); launcher.home(); platform.ready(); await flush();
    await vi.advanceTimersByTimeAsync(1000); expect(launcher.open()).toBe(false);
    platform.setLocal({ phase: 'starting', version: null }); await launcher.choose('local'); await flush();
    platform.fail(); await flush(); expect(launcher.pendingId()).toBeNull();
    platform.setLocal({ phase: 'starting', version: null }); await launcher.choose('local'); platform.ready(); await flush();
    TestBed.resetTestingModule(); await vi.advanceTimersByTimeAsync(1000);
    expect(launcher.open()).toBe(false); expect((await platform.machineState()).hasOpenedMachine).toBe(false);
  });

  it('lets the last selection win and opens a separate window without changing this one', async () => {
    const { platform, launcher, connection } = setup(); await flush();
    const host = await connection.addHost({ name: 'Dev', host: 'dev' });
    await launcher.choose('local'); platform.ready(); await flush();
    await launcher.choose(host.id); await flush();
    await vi.advanceTimersByTimeAsync(500); expect(launcher.open()).toBe(false);
    platform.ready(); await flush();
    await launcher.choose('local'); await flush(); await vi.advanceTimersByTimeAsync(500); await flush();
    expect(launcher.currentId()).toBe('local'); expect(launcher.open()).toBe(true);
    const remote = launcher.machines().find(machine => machine.id === host.id);
    expect(remote).toBeDefined();
    if (remote) await launcher.openMachine({ machine: remote, newWindow: true });
    expect(platform.windows).toEqual([{ kind: 'remote', hostId: host.id }]);
    expect(launcher.currentId()).toBe('local'); expect((await platform.machineState()).environment.selection.kind).toBe('local');
  });

  it('does not connect a server after its add dialog was cancelled during persistence', async () => {
    const { platform } = setup(); const ssh = TestBed.inject(SshSetupService); await flush();
    let resolve!: (host: { id: string; name: string; host: string }) => void;
    vi.spyOn(platform, 'saveRemoteHost').mockImplementation(() => new Promise(done => { resolve = done; }));
    const select = vi.spyOn(platform, 'selectEnvironment');
    ssh.begin(document.createElement('button')); ssh.pick('dev-box');
    const connecting = ssh.connect(); ssh.cancel();
    resolve({ id: 'saved', name: 'dev-box', host: 'dev-box' }); await connecting; await flush();
    expect(select).not.toHaveBeenCalled(); expect(ssh.open()).toBe(false);
  });

  it('retains failed download progress, prioritizes it on Home, and clears the error on retry', async () => {
    const { platform, launcher } = setup(); await flush();
    expect(launcher.machines()[0]?.busy?.progress).toBe(.42);
    platform.fail(); await flush();
    expect(launcher.machines()[0]?.error?.progress).toBe(.42);
    expect(machineHomeStatus(launcher.machines())?.text).toBe("Couldn't download the engine");
    expect(machineHomeStatus(launcher.machines())?.tone).toBe('warn');
    await launcher.choose('local'); await flush();
    expect(launcher.machines()[0]?.error).toBeUndefined();
    expect(launcher.machines()[0]?.busy).toBeDefined();
  });

  it('reserves danger for host trust failures while keeping the island amber', async () => {
    const { platform, connection } = setup(); await flush();
    const host = await connection.addHost({ name: 'dev-box', host: 'dev-box' }); await connection.select({ kind: 'remote', hostId: host.id });
    const status = (await platform.machineState()).environment.connection!;
    const machine = { id: host.id, name: 'dev-box', kind: 'ssh' as const, ...remotePresentation({ ...status, phase: 'paused', progress: { receivedBytes: 38, totalBytes: 100 }, failure: { stage: 'authentication', code: 'host-trust', message: 'The host key changed', action: 'verify-host', transient: false } }) };
    expect(machine.error).toEqual({ step: 'The host key changed', tone: 'danger', progress: .38, action: 'Review the key' });
    expect(machineHomeStatus([machine])?.tone).toBe('warn');
  });

  it('keeps a failed server actionable after another machine is selected, until it retries', async () => {
    const { platform, launcher, connection } = setup(); await flush();
    const host = await connection.addHost({ name: 'dev-box', host: 'dev-box' });
    await launcher.choose(host.id); platform.fail(); await flush();
    expect(launcher.machines().find(machine => machine.id === host.id)?.error).toBeDefined();
    await launcher.choose('local'); await flush();
    expect(launcher.machines().find(machine => machine.id === host.id)?.error?.step).toBe('Sign-in was refused');
    await launcher.choose(host.id); await flush();
    const machine = launcher.machines().find(machine => machine.id === host.id);
    expect(machine?.error).toBeUndefined(); expect(machine?.busy).toBeDefined();
  });

  it('accepts explicit SSH destinations and rejects command syntax and invalid ports', () => {
    expect(parseSshDestination('leo@dev-box:2222')).toEqual({ name: 'leo@dev-box:2222', host: 'dev-box', user: 'leo', port: 2222 });
    expect(parseSshDestination('dev')).toEqual({ name: 'dev', host: 'dev' });
    for (const value of ['dev:0', 'dev:65536', '-oProxyCommand=evil', 'dev;touch x', '$(whoami)', 'host\ncommand']) expect(parseSshDestination(value)).toBeNull();
  });

  it('can cancel and immediately reselect the same ready machine before the next render', async () => {
    const { platform, launcher } = setup(); await flush();
    await launcher.choose('local'); platform.ready(); await flush();
    launcher.home(); await launcher.choose('local'); await flush();
    await vi.advanceTimersByTimeAsync(500); await flush();
    expect(launcher.open()).toBe(true); expect(launcher.currentId()).toBe('local');
  });

  it('clears a credential after submitting, rejects expired prompts and renders no raw HTML', async () => {
    const fixture = TestBed.createComponent(RemoteChallengeDialogComponent);
    const challenge = { id: 'credential', kind: 'credential', prompt: '<b>Passphrase</b>', expiresAt: Date.now() + 1000 };
    fixture.componentRef.setInput('machineName', 'Dev'); fixture.componentRef.setInput('challenge', challenge); fixture.detectChanges();
    const answered = vi.fn(); fixture.componentInstance.answered.subscribe(answered);
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'temporary'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true })); fixture.detectChanges();
    expect(answered).toHaveBeenCalledExactlyOnceWith({ id: 'credential', answer: 'temporary' });
    expect(input.value).toBe(''); expect(fixture.nativeElement.querySelector('.prompt b')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); fixture.detectChanges();
    expect(input.disabled).toBe(true); expect(fixture.nativeElement.textContent).toContain('expired');
  });
});
