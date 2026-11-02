import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BackendResult, TaskTerminal, TaskTerminalList } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskTerminalComponent } from './task-terminal.component';

const terminal = (taskId: number, id = 1): TaskTerminal => ({
  id, taskId, title: 'zsh', cwd: '/task', branch: 'work', generation: 'generation',
  sequence: 0, alive: true, status: 'idle', command: '', exitCode: 0, port: null, canRerun: false,
});

async function settle(fixture: ComponentFixture<TaskTerminalComponent>): Promise<void> {
  for (let pass = 0; pass < 30; pass++) { await Promise.resolve(); fixture.detectChanges(); }
  await fixture.whenStable();
}

function setup(initial: readonly TaskTerminal[] = []) {
  const rows = new Map<number, readonly TaskTerminal[]>([[1, initial]]);
  const page = (taskId: number): BackendResult<TaskTerminalList> => ({
    ok: true, value: { taskId, terminals: rows.get(taskId) ?? [], scripts: [], limit: 16 },
  });
  const bridge = {
    taskTerminalList: vi.fn(async (_scope: string, taskId: number) => page(taskId)),
    taskTerminalCreate: vi.fn(async (_scope: string, input: { taskId: number }) => {
      const row = terminal(input.taskId);
      rows.set(input.taskId, [row]);
      return { ok: true, value: row };
    }),
    taskTerminalClose: vi.fn(async (_scope: string, input: { taskId: number; terminalId: number }) => {
      rows.set(input.taskId, rows.get(input.taskId)?.filter(row => row.id !== input.terminalId) ?? []);
      return { ok: true, value: { closed: true } };
    }),
    taskTerminalRead: vi.fn(() => new Promise(() => {})),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: BackendClientService, useValue: { state: signal({ revision: 1, scope: { id: 'scope' } }) } },
    { provide: ELEVENEX_BRIDGE, useValue: bridge },
  ] });
  // Exercise lifecycle ownership without xterm's browser-only layout adapter.
  TestBed.overrideComponent(TaskTerminalComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(TaskTerminalComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1 });
  const component = fixture.componentInstance;
  const lastClosed = vi.fn(); component.lastClosed.subscribe(lastClosed);
  return { fixture, component, bridge, rows, page, lastClosed };
}

describe('Task terminal panel lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('starts one shell only when opened, reuses it on reopening and refresh, and creates after the last close', async () => {
    const { fixture, component, bridge, lastClosed } = setup();
    await settle(fixture);
    expect(bridge.taskTerminalList).not.toHaveBeenCalled();
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledExactlyOnceWith('scope', { taskId: 1 });
    await component.store.refresh(); await settle(fixture);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    await component.close('1'); await settle(fixture);
    expect(lastClosed).toHaveBeenCalledTimes(1);
    expect(component.store.snapshot()?.terminals).toHaveLength(0);
    await component.store.refresh(); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(2);
  });

  it('checks the backend before starting from an empty cached task', async () => {
    const { fixture, bridge, rows } = setup();
    fixture.componentRef.setInput('available', false);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    rows.set(1, [terminal(1)]);
    fixture.componentRef.setInput('available', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
  });

  it('starts an empty task when switching with Terminal visible and preserves same-task selections', async () => {
    const { fixture, bridge } = setup([terminal(1)]);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 2 }); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledExactlyOnceWith('scope', { taskId: 2 });
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 2 }); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending opening when hidden or switched to another task', async () => {
    const { fixture, bridge, page, rows } = setup();
    let resolve!: (value: BackendResult<TaskTerminalList>) => void;
    bridge.taskTerminalList.mockImplementation(() => new Promise(done => { resolve = done; }));
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    resolve(page(1)); await settle(fixture);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    bridge.taskTerminalList.mockImplementation(async (_scope, taskId) => page(taskId));
    rows.set(2, [terminal(2)]);
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 2 });
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
  });

  it('does not retry uncertain startup on refresh or reconnect', async () => {
    const { fixture, bridge, component } = setup();
    bridge.taskTerminalCreate.mockRejectedValue(new Error('Connection lost'));
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(component.store.error()).toContain('Startup outcome is unknown');
    await component.store.refresh(); await settle(fixture);
    fixture.componentRef.setInput('available', false); await settle(fixture);
    fixture.componentRef.setInput('available', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open after a list failure or failed close and when other tabs remain', async () => {
    const { fixture, component, bridge, page, lastClosed } = setup([terminal(1), terminal(1, 2)]);
    bridge.taskTerminalList.mockResolvedValue({ ok: false, error: { code: 'transport', message: 'Offline' } });
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
    bridge.taskTerminalList.mockImplementation(async (_scope, taskId) => page(taskId));
    await component.store.refresh(); await component.close('1'); await settle(fixture);
    expect(lastClosed).not.toHaveBeenCalled();
    bridge.taskTerminalClose.mockRejectedValue(new Error('Connection lost'));
    await component.close('2'); await settle(fixture);
    expect(lastClosed).not.toHaveBeenCalled();
    expect(component.store.snapshot()?.terminals).toHaveLength(1);
  });

  for (const destination of ['hidden', 'task'] as const) it(`ignores a late last-close after navigating to ${destination}`, async () => {
    const { fixture, bridge, rows, lastClosed } = setup([terminal(1)]);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    let resolve!: (value: { ok: boolean; value: { closed: boolean } }) => void;
    bridge.taskTerminalClose.mockImplementation(() => new Promise(done => { resolve = done; }));
    const closing = fixture.componentInstance.close('1');
    if (destination === 'hidden') fixture.componentRef.setInput('visible', false);
    else {
      rows.set(2, [terminal(2)]);
      fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 2 });
    }
    await settle(fixture);
    rows.set(1, []); resolve({ ok: true, value: { closed: true } });
    await closing; await settle(fixture);
    expect(lastClosed).not.toHaveBeenCalled();
    expect(bridge.taskTerminalCreate).not.toHaveBeenCalled();
  });
});
