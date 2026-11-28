import type { TaskTerminalStreamPacket, TaskTerminalSize } from '@elevenex/shared';
import { parseTaskTerminal, parseTerminalList, parseTerminalOutput } from './task-terminal';
import { object, integer, text } from './terminal-validation';
import { invalidResponse } from './transport';

export function terminalSize(raw: unknown): TaskTerminalSize {
  const value = object(raw);
  return { cols: integer(value['cols'], 2, 500), rows: integer(value['rows'], 1, 300) };
}
export function parseTerminalStreamPacket(raw: unknown, task: number, id: number): TaskTerminalStreamPacket {
  const value = object(raw);
  switch (value['type']) {
    case 'output': return { type: 'output', delivery: integer(value['delivery'], 1), output: parseTerminalOutput(value['output'], task, id) };
    case 'snapshot': {
      const terminal = parseTaskTerminal(value['terminal'], task, id);
      const sequence = integer(value['sequence'], 0, terminal.sequence);
      if (!terminal.generation || typeof value['first'] !== 'boolean' || typeof value['last'] !== 'boolean') throw invalidResponse();
      return { type: 'snapshot', terminal, sequence, delivery: integer(value['delivery'], 1),
        size: terminalSize(value['size']), data: text(value['data'], 32768), first: value['first'], last: value['last'] };
    }
    case 'metadata': return { type: 'metadata', list: parseTerminalList(value['list'], task) };
    case 'input-ack': return { type: 'input-ack', sequence: integer(value['sequence'], 1) };
    case 'control':
      if (typeof value['writable'] !== 'boolean') throw invalidResponse();
      return { type: 'control', writable: value['writable'] };
    case 'closed':
      if (typeof value['uncertain'] !== 'boolean') throw invalidResponse();
      return { type: 'closed', uncertain: value['uncertain'], message: text(value['message'], 256) };
    default: throw invalidResponse();
  }
}
