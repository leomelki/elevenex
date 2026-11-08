import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { TaskTerminal, TaskTerminalRead } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskTerminalComponent } from './task-terminal.component';
import { TerminalSurface } from './terminal-surface';

// xterm installs media listeners at import time, before per-test setup runs.
vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterAll(() => vi.unstubAllGlobals());

async function settle(fixture: ComponentFixture<TaskTerminalComponent>) {
  for (let pass = 0; pass < 30; pass++) { await Promise.resolve(); fixture.detectChanges(); }
  await fixture.whenStable();
}

function setup() {
  // Replace only layout/drawing; retain real xterm input events and disposal.
  const surfaces: TerminalSurface[] = [];
  vi.spyOn(TerminalSurface.prototype, 'attach').mockImplementation(function (this: TerminalSurface) {
    if (!surfaces.includes(this)) surfaces.push(this);
  });
  vi.spyOn(TerminalSurface.prototype, 'focus').mockImplementation(() => {});
  const drawing = vi.spyOn(TerminalSurface.prototype, 'write').mockResolvedValue();
  const row: TaskTerminal = {
    id: 1, taskId: 1, title: 'Shell', cwd: '/task', branch: 'work',
    generation: 'original', sequence: 0, alive: true, status: 'idle',
    command: '', exitCode: null, port: null, canRerun: false,
  };
  const bridge = {
    taskTerminalList: vi.fn(async () => ({ ok: true, value: {
      taskId: 1, terminals: [row], scripts: [], limit: 16,
    } })),
    taskTerminalRead: vi.fn(async (_scope: string, input: TaskTerminalRead) => ({ ok: true, value: {
      terminal: row, generation: row.generation, from: input.after, next: input.after,
      data: '', gap: false, more: false,
    } })),
    taskTerminalInput: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: BackendClientService, useValue: { state: signal({ scope: { id: 'scope' } }) } },
    { provide: ELEVENEX_BRIDGE, useValue: bridge },
  ] });
  TestBed.overrideComponent(TaskTerminalComponent, { set: { template: '<div #surface></div>', imports: [] } });
  const fixture = TestBed.createComponent(TaskTerminalComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1 });
  fixture.componentRef.setInput('visible', true);
  return { fixture, bridge, row, surfaces, drawing, component: fixture.componentInstance };
}

describe('Task terminal attachment ownership', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });

  it('stops queued paste on detach and requires explicit resume on reopening', async () => {
    const { fixture, bridge, component, surfaces } = setup();
    await vi.waitFor(async () => { await settle(fixture); expect(surfaces).toHaveLength(1); });
    let complete!: (result: { ok: boolean; value: { accepted: boolean } }) => void;
    bridge.taskTerminalInput.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    surfaces[0]!.setEnabled(true);
    surfaces[0]!.terminal.input('x'.repeat(9000), true);
    await settle(fixture);
    expect(bridge.taskTerminalInput).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    complete({ ok: true, value: { accepted: true } }); await settle(fixture);
    expect(bridge.taskTerminalInput).toHaveBeenCalledTimes(1);
    expect(component.inputBlocked()).toBe(true);
    component.resumeInput();
    surfaces[0]!.terminal.input('new', true); await settle(fixture);
    expect(bridge.taskTerminalInput).toHaveBeenLastCalledWith('scope', {
      taskId: 1, terminalId: 1, generation: 'original', data: 'new',
    });
  });

  it('waits for a drawing output page before reading again on rapid reattachment', async () => {
    const { fixture, bridge, row, drawing } = setup();
    let complete!: () => void;
    // Hold the first backend reply until the surface exists, then hold xterm drawing.
    let reply!: (result: Awaited<ReturnType<typeof bridge.taskTerminalRead>>) => void;
    bridge.taskTerminalRead.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    await vi.waitFor(async () => { await settle(fixture); expect(bridge.taskTerminalRead).toHaveBeenCalledTimes(1); });
    drawing.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    reply({ ok: true, value: {
      terminal: { ...row, sequence: 4 }, generation: row.generation,
      from: 0, next: 4, data: 'page', gap: false, more: false,
    } });
    await settle(fixture);
    expect(drawing).toHaveBeenCalledWith('page', undefined, false, undefined, 0);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalRead).toHaveBeenCalledTimes(1);
    complete(); await settle(fixture);
    expect(bridge.taskTerminalRead.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(bridge.taskTerminalRead).toHaveBeenLastCalledWith('scope', {
      taskId: 1, terminalId: 1, generation: 'original', after: 4,
    });
    expect(drawing.mock.calls.filter(([data]) => data === 'page')).toHaveLength(1);
  });
});
