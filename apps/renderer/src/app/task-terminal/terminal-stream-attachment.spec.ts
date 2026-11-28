import type { ElevenexBridge, TaskTerminalStreamEvent, TaskTerminalStreamPacket } from '@elevenex/shared';
import { TerminalStreamAttachment } from './terminal-stream-attachment';
import { TerminalSurface } from './terminal-surface';

vi.hoisted(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterAll(() => vi.unstubAllGlobals());

function setup() {
  let listener: (event: TaskTerminalStreamEvent) => void = () => {};
  const stop = vi.fn(), ack = vi.fn(async () => {}), detach = vi.fn(async () => {});
  const bridge = {
    onTaskTerminalStream: (callback: typeof listener) => { listener = callback; return stop; },
    taskTerminalAttach: vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } })),
    taskTerminalStreamAcknowledge: ack, taskTerminalDetach: detach,
    taskTerminalStreamWrite: vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } })),
  };
  const surface = new TerminalSurface(() => {}, () => {}, () => { throw new Error('No DOM'); });
  vi.spyOn(surface, 'fit').mockImplementation(() => {});
  const owner = { inputIdle: vi.fn(() => true), terminal: vi.fn(), metadata: vi.fn(), changed: vi.fn(), interrupted: vi.fn() };
  const attachment = new TerminalStreamAttachment(bridge as unknown as ElevenexBridge, 'scope', {
    taskId: 1, terminalId: 2, generation: null, after: 0,
  }, surface, owner);
  const terminal = { id: 2, taskId: 1, title: 'bash', cwd: '/task', branch: 'work', generation: 'generation', sequence: 5,
    alive: true, status: 'idle' as const, command: '', exitCode: 0, port: null, canRerun: false };
  const emit = (packet: TaskTerminalStreamPacket, changes: Partial<TaskTerminalStreamEvent> = {}) => listener({ ...attachment.target, scopeId: 'scope', packet, ...changes });
  return { attachment, surface, owner, terminal, emit, bridge, ack, stop, detach };
}

describe('Terminal stream view ownership', () => {
  afterEach(() => vi.restoreAllMocks());
  it('commits snapshots before returning credits and rejects stale events', async () => {
    const { attachment, surface, emit, terminal, ack, owner, stop, detach } = setup();
    try {
      await attachment.start(); emit({ type: 'control', writable: true });
      const packet = { type: 'snapshot' as const, delivery: 1, terminal, sequence: 5, size: { cols: 80, rows: 24 }, data: 'hello', first: true, last: true };
      emit(packet, { scopeId: 'other' }); await attachment.settled(); expect(ack).not.toHaveBeenCalled();
      emit(packet); expect(ack).not.toHaveBeenCalled(); await attachment.settled();
      expect(surface.context()).toBe('hello'); expect(surface.sequence).toBe(5); expect(attachment.ready).toBe(true);
      expect(ack).toHaveBeenCalledWith('scope', { taskId: 1, terminalId: 2, attachmentId: attachment.target.attachmentId, delivery: 1 });
      attachment.dispose(); expect(stop).toHaveBeenCalledTimes(1); expect(detach).toHaveBeenCalledTimes(1);
      emit({ type: 'closed', uncertain: true, message: 'old connection' });
      expect(owner.interrupted).not.toHaveBeenCalled();
    } finally { attachment.dispose(); surface.dispose(); }
  });
  it('pipelines input without waiting for remote acknowledgements and flags interrupted outcomes', async () => {
    const { attachment, surface, emit, terminal, bridge, owner } = setup();
    try {
      await attachment.start(); emit({ type: 'control', writable: true });
      emit({ type: 'snapshot', delivery: 1, terminal, sequence: 5, size: { cols: 80, rows: 24 }, data: '$ ', first: true, last: true });
      await attachment.settled();
      expect(await attachment.input('a', 'generation', 'text')).toBe(true);
      expect(await attachment.input('b', 'generation', 'text')).toBe(true);
      expect(bridge.taskTerminalStreamWrite.mock.calls).toHaveLength(2);
      emit({ type: 'input-ack', sequence: 1 });
      emit({ type: 'closed', uncertain: false, message: 'disconnected' });
      expect(owner.interrupted).toHaveBeenCalledWith('disconnected', true);
      expect(attachment.ready).toBe(false);
      expect(await attachment.input('c', 'generation', 'text')).toBe(false);
    } finally { attachment.dispose(); surface.dispose(); }
  });
  it('does not return a credit or advance a replacement surface before a pending write completes', async () => {
    const { attachment, surface, emit, terminal, ack } = setup();
    let complete!: () => void;
    vi.spyOn(surface, 'write').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    try {
      await attachment.start();
      emit({ type: 'snapshot', delivery: 1, terminal, sequence: 5, size: { cols: 80, rows: 24 }, data: 'hello', first: true, last: true });
      await Promise.resolve(); expect(ack).not.toHaveBeenCalled();
      attachment.dispose(); complete(); await attachment.settled();
      expect(ack).not.toHaveBeenCalled(); expect(surface.sequence).toBe(5);
    } finally { attachment.dispose(); surface.dispose(); }
  });
  it('does not grant prediction from a prompt that raced with locally queued input', async () => {
    const { attachment, surface, emit, terminal, owner } = setup();
    try {
      surface.localEcho.latencyThreshold = 0;
      await attachment.start(); emit({ type: 'control', writable: true });
      emit({ type: 'snapshot', delivery: 1, terminal, sequence: 5, size: { cols: 80, rows: 24 }, data: '', first: true, last: true });
      await attachment.settled(); owner.inputIdle.mockReturnValue(false);
      emit({ type: 'output', delivery: 2, output: { terminal: { ...terminal, shellIntegration: 'active', sequence: 7 },
        generation: 'generation', from: 5, next: 7, data: '$ ', more: false, gap: false, inputPreview: { prompt: 7 } } });
      await attachment.settled(); surface.setEnabled(true); surface.terminal.input('secret', true);
      await new Promise<void>(resolve => surface.terminal.write('', resolve));
      expect(surface.context()).toBe('$'); expect(surface.localEcho.predicting).toBe(false);
    } finally { attachment.dispose(); surface.dispose(); }
  });
});
