import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { TaskTerminal, TaskTerminalAttach, TaskTerminalStreamEvent, TaskTerminalStreamPacket } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TaskTerminalComponent } from './task-terminal.component';
import { TerminalSurface } from './terminal-surface';

vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));

async function settle(fixture: ComponentFixture<TaskTerminalComponent>): Promise<void> {
  for (let pass = 0; pass < 30; pass++) { await Promise.resolve(); fixture.detectChanges(); }
  await fixture.whenStable();
}

function setup() {
  let row: TaskTerminal = { id: 1, taskId: 1, title: 'bash', cwd: '/task', branch: 'work', generation: 'generation',
    sequence: 0, alive: true, status: 'idle', command: '', exitCode: null, port: null, canRerun: false };
  let created = false;
  const listeners = new Set<(event: TaskTerminalStreamEvent) => void>();
  const page = () => ({ taskId: 1, terminals: created ? [row] : [], scripts: [], limit: 16 as const, streamVersion: 1 as const });
  const accepted = { ok: true as const, value: { accepted: true as const } };
  const bridge = {
    taskTerminalList: vi.fn(async () => ({ ok: true as const, value: page() })),
    taskTerminalCreate: vi.fn(async () => { created = true; return { ok: true as const, value: row }; }),
    taskTerminalPreferences: vi.fn(async () => ({ ok: true as const, value: { profile: null, prediction: 'auto' } })),
    taskTerminalAttach: vi.fn<(scope: string, target: TaskTerminalAttach) => Promise<typeof accepted>>(async () => accepted),
    taskTerminalDetach: vi.fn(async () => {}),
    taskTerminalStreamWrite: vi.fn(async () => accepted),
    taskTerminalStreamResize: vi.fn(async () => accepted),
    taskTerminalStreamFocus: vi.fn(async () => accepted),
    taskTerminalStreamAcknowledge: vi.fn(async () => {}),
    onTaskTerminalStream: (listener: (event: TaskTerminalStreamEvent) => void) => {
      listeners.add(listener); return () => listeners.delete(listener);
    },
  };
  const backend = signal({ revision: 1, scope: { id: 'scope' } });
  TestBed.configureTestingModule({ providers: [
    { provide: BackendClientService, useValue: { state: backend } },
    { provide: ELEVENEX_BRIDGE, useValue: bridge },
  ] });
  TestBed.overrideComponent(TaskTerminalComponent, { set: { template: '<div #surface></div>', imports: [] } });
  // Keep the real xterm DOM, ANSI parser and input path. jsdom cannot measure
  // cells or create WebGL contexts, so omit only those browser layout adapters.
  const surfaces: TerminalSurface[] = [];
  const attach = vi.spyOn(TerminalSurface.prototype, 'attach').mockImplementation(function (this: TerminalSurface, host) {
    if (!this.terminal.element) { this.terminal.open(host); surfaces.push(this); }
    else host.append(this.terminal.element);
  });
  vi.spyOn(TerminalSurface.prototype, 'fit').mockImplementation(() => {});
  const detach = vi.spyOn(TerminalSurface.prototype, 'detach');
  const fixture = TestBed.createComponent(TaskTerminalComponent);
  fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1 });
  fixture.componentRef.setInput('visible', true);
  const emit = (packet: TaskTerminalStreamPacket, target = bridge.taskTerminalAttach.mock.calls.at(-1)![1]) => {
    for (const listener of listeners) listener({ ...target, scopeId: 'scope', packet });
  };
  const metadata = (changes: Partial<TaskTerminal> = {}) => { row = { ...row, ...changes }; emit({ type: 'metadata', list: page() }); };
  const handshake = async () => {
    metadata(); emit({ type: 'control', writable: true });
    emit({ type: 'snapshot', delivery: 1, terminal: row, sequence: 0, size: { cols: 80, rows: 24 }, data: '$ ', first: true, last: true });
    await vi.waitFor(() => expect(bridge.taskTerminalStreamAcknowledge).toHaveBeenCalled());
    await settle(fixture);
  };
  return { fixture, component: fixture.componentInstance, bridge, surfaces, attach, detach, emit, metadata, handshake, backend,
    get row() { return row; } };
}

describe('Task terminal streaming attachment lifetime', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('auto-creates once and retains its focused, writable DOM through metadata and output updates', async () => {
    const state = setup();
    const { fixture, bridge, surfaces, attach, detach, emit, metadata, component } = state;
    await settle(fixture);
    await vi.waitFor(() => expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1));
    await state.handshake();
    const surface = surfaces[0]!;
    const node = surface.terminal.element;
    surface.focus();
    const focused = document.activeElement;
    expect(node?.contains(focused)).toBe(true);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    for (const changes of [{ activityTitle: 'node', status: 'running' as const }, { currentCwd: '/task/subfolder' },
      { status: 'serving' as const, port: 3000 }, { activityTitle: null, status: 'idle' as const }]) {
      metadata(changes); await settle(fixture);
    }
    emit({ type: 'output', delivery: 2, output: { terminal: { ...state.row, sequence: 5 },
      generation: 'generation', from: 0, next: 5, data: 'hello', gap: false, more: false } });
    await vi.waitFor(() => expect(bridge.taskTerminalStreamAcknowledge).toHaveBeenCalledTimes(2));
    await settle(fixture);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1);
    expect(bridge.taskTerminalDetach).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1); expect(detach).not.toHaveBeenCalled();
    expect(surface.terminal.element).toBe(node);
    expect(document.activeElement).toBe(focused);
    expect(surface.terminal.options.disableStdin).toBe(false);
    expect(surface.context()).toContain('hello');
    expect(component.tabs()[0]?.cwd).toBe('/task/subfolder');
    surface.terminal.input('x', true);
    await vi.waitFor(() => expect(bridge.taskTerminalStreamWrite).toHaveBeenCalledExactlyOnceWith('scope', {
      taskId: 1, terminalId: 1, attachmentId: bridge.taskTerminalAttach.mock.calls[0]![1].attachmentId,
      generation: 'generation', sequence: 1, kind: 'text', data: 'x',
    }));
    expect(timers.mock.calls.filter(call => call[1] === 500)).toHaveLength(0);
  });

  it('replaces an interrupted stream once after backoff, ignores stale events and cancels retries on recovery/hide', async () => {
    const state = setup();
    const { fixture, bridge, emit } = state;
    await settle(fixture);
    await vi.waitFor(() => expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1));
    await state.handshake();
    const old = bridge.taskTerminalAttach.mock.calls[0]![1];
    vi.useFakeTimers();
    try {
      emit({ type: 'closed', uncertain: false, message: 'disconnected' });
      await settle(fixture);
      expect(bridge.taskTerminalDetach).toHaveBeenCalledExactlyOnceWith('scope', {
        taskId: 1, terminalId: 1, attachmentId: old.attachmentId,
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); await settle(fixture);
      expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(2);
      const replacement = bridge.taskTerminalAttach.mock.calls[1]![1];
      expect(replacement.attachmentId).not.toBe(old.attachmentId);
      emit({ type: 'control', writable: true });
      emit({ type: 'output', delivery: 1, output: { terminal: state.row, generation: 'generation', from: 0, next: 0, data: '', gap: false, more: false } });
      await vi.advanceTimersByTimeAsync(0); await settle(fixture);
      emit({ type: 'closed', uncertain: true, message: 'stale' }, old);
      await vi.advanceTimersByTimeAsync(30000); await settle(fixture);
      expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(2);
      expect(bridge.taskTerminalDetach).toHaveBeenCalledTimes(1);
      expect(state.surfaces[0]!.terminal.options.disableStdin).toBe(false);
      expect(state.component.notice()).toBe('');
      emit({ type: 'closed', uncertain: false, message: 'another interruption' });
      fixture.componentRef.setInput('visible', false); await settle(fixture);
      await vi.advanceTimersByTimeAsync(30000);
      expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('reattaches for generation and visibility changes while reusing the task surface', async () => {
    const state = setup();
    const { fixture, bridge, surfaces, metadata, attach } = state;
    await settle(fixture);
    await vi.waitFor(() => expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1));
    await state.handshake();
    const node = surfaces[0]!.terminal.element;
    fixture.componentRef.setInput('selection', { scopeId: 'scope', taskId: 1 });
    await settle(fixture);
    expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(1);
    metadata({ generation: 'replacement-generation' }); await settle(fixture);
    expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(2);
    expect(bridge.taskTerminalDetach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(surfaces[0]!.terminal.element).toBe(node);
    fixture.componentRef.setInput('visible', false); await settle(fixture);
    expect(node?.isConnected).toBe(false);
    expect(bridge.taskTerminalDetach).toHaveBeenCalledTimes(2);
    fixture.componentRef.setInput('visible', true); await settle(fixture);
    expect(bridge.taskTerminalAttach).toHaveBeenCalledTimes(3);
    expect(bridge.taskTerminalCreate).toHaveBeenCalledTimes(1);
    expect(surfaces[0]!.terminal.element).toBe(node);
    expect(node?.isConnected).toBe(true);
  });

  it('retains failed process output without sending resizes or retrying its healthy stream', async () => {
    const state = setup();
    await settle(state.fixture);
    await vi.waitFor(() => expect(state.bridge.taskTerminalAttach).toHaveBeenCalledTimes(1));
    await state.handshake();
    state.surfaces[0]!.terminal.resize(90, 20);
    await vi.waitFor(() => expect(state.bridge.taskTerminalStreamResize).toHaveBeenCalledTimes(1));
    state.metadata({ alive: false, status: 'failed', exitCode: 7, command: 'pnpm fail', canRerun: true });
    await settle(state.fixture);
    state.bridge.taskTerminalStreamResize.mockClear();
    state.surfaces[0]!.terminal.resize(100, 25);
    state.surfaces[0]!.terminal.resize(110, 30);
    await settle(state.fixture);
    expect(state.bridge.taskTerminalStreamResize).not.toHaveBeenCalled();
    expect(state.bridge.taskTerminalAttach).toHaveBeenCalledTimes(1);
    expect(state.bridge.taskTerminalDetach).not.toHaveBeenCalled();
    expect(state.component.notice()).toBe('');
    expect(state.component.inputBlocked()).toBe(false);
    expect(state.surfaces[0]!.terminal.options.disableStdin).toBe(true);
    expect(state.surfaces[0]!.context()).toContain('$');
  });

  it('preserves the input warning through repeated interruptions until explicit resume', async () => {
    const state = setup();
    await settle(state.fixture);
    await vi.waitFor(() => expect(state.bridge.taskTerminalAttach).toHaveBeenCalledTimes(1));
    await state.handshake();
    state.emit({ type: 'closed', uncertain: true, message: 'Legacy engine input interruption' });
    await settle(state.fixture);
    expect(state.component.inputBlocked()).toBe(true);
    expect(state.component.notice()).toContain('Some keystrokes');
    await vi.waitFor(() => expect(state.bridge.taskTerminalAttach).toHaveBeenCalledTimes(2));
    await state.handshake();
    const warning = state.component.notice();
    state.emit({ type: 'closed', uncertain: false, message: 'Another interruption' });
    await settle(state.fixture);
    expect(state.component.notice()).toBe(warning);
    expect(state.component.inputBlocked()).toBe(true);
    expect(state.bridge.taskTerminalStreamWrite).not.toHaveBeenCalled();
    state.fixture.componentRef.setInput('visible', false);
    await settle(state.fixture);
  });
});
