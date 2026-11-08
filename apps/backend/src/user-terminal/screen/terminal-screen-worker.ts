import { parentPort } from 'node:worker_threads';
import { release } from 'node:os';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { TerminalParserTail } from './terminal-parser-tail.js';
import type { ScreenRequest, ScreenResponse } from './terminal-screen-protocol.js';

const port = parentPort;
if (!port) throw new Error('Terminal screen worker requires a parent');
const screens = new Map<number, {
  terminal: Terminal; serialize: SerializeAddon; tail: TerminalParserTail; sequence: number; incarnation: number;
}>();
const send = (value: ScreenResponse) => port.postMessage(value);
// One worker per manager, not per terminal. Arrival order includes writes,
// geometry and checkpoint barriers. xterm work never runs on Nest's event loop.
let pending = Promise.resolve();
port.on('message', (message: ScreenRequest) => {
  pending = pending.then(async () => {
    if (message.type === 'open') {
      if (screens.size >= 128 || screens.has(message.id)) throw new Error('Terminal screen limit');
      const terminal = new Terminal({ cols: message.cols, rows: message.rows, scrollback: 2000, allowProposedApi: true,
        ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: Number(release().split('.')[2]) || 0 } } : {}),
      });
      const serialize = new SerializeAddon();
      terminal.loadAddon(serialize); terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';
      terminal.onData(data => send({ type: 'reply', id: message.id, incarnation: message.incarnation, data }));
      screens.set(message.id, { terminal, serialize, sequence: 0, tail: new TerminalParserTail(), incarnation: message.incarnation });
      return;
    }
    const screen = screens.get(message.id);
    if (!screen || screen.incarnation !== message.incarnation) {
      if ('request' in message) throw new Error('Terminal screen is unavailable');
      return;
    }
    if (message.type === 'write') {
      screen.tail.append(message.data);
      await new Promise<void>(resolve => screen.terminal.write(message.data, resolve));
      screen.sequence = message.next;
      send({ type: 'consumed', id: message.id, incarnation: message.incarnation, length: message.data.length });
    } else if (message.type === 'resize') screen.terminal.resize(message.cols, message.rows);
    else if (message.type === 'snapshot') {
      const data = screen.serialize.serialize({ scrollback: 2000 }) + screen.tail.suffix();
      if (data.length > 4 * 1024 * 1024) throw new Error('Terminal screen exceeds the restore limit');
      send({ type: 'result', request: message.request, value: {
        sequence: screen.sequence, cols: screen.terminal.cols, rows: screen.terminal.rows, data,
      } });
    } else if (message.type === 'context') {
      const buffer = screen.terminal.buffer.active, lines: string[] = [];
      for (let row = Math.max(0, buffer.length - 80); row < buffer.length; row++)
        lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
      send({ type: 'result', request: message.request, value: lines.join('\n').trim().slice(-8000) });
    } else {
      screen.terminal.dispose(); screens.delete(message.id);
    }
  }).catch(() => {
    if ('request' in message) send({ type: 'failure', request: message.request, message: 'Terminal screen is unavailable.' });
    else throw new Error('Terminal screen worker failed');
  });
});
