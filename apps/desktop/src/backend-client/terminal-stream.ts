import { WebSocket } from 'ws';
import { connectTerminalStream, type TerminalStreamConnection } from './terminal-stream-connection';
import type { BackendResult, TaskTerminalAttachment, TaskTerminalAttach, TaskTerminalStreamWrite } from '@elevenex/shared';
import { handleForWindow, sendToWindow, type TrustedSender } from '../ipc';
import type { BackendClient } from './client';
import { object, integer, generation, keys } from './terminal-validation';
import { terminalSize } from './terminal-stream-validation';
import { invalidResponse, requestBackendJson } from './transport';

const accepted = { ok: true as const, value: { accepted: true as const } };
const unavailable = (): BackendResult<never> => ({ ok: false, error: { code: 'unavailable', message: 'The terminal stream is unavailable. Reattach before typing.' } });

function attachment(raw: unknown): TaskTerminalAttachment {
  const value = object(raw);
  return { taskId: integer(value['taskId'], 1), terminalId: integer(value['terminalId'], 1), attachmentId: generation(value['attachmentId']) };
}

/** One visible attachment per window. End-to-end credits cover Electron IPC as
 * well as the network. Raw bytes never enter Angular's change graph. */
export function registerTerminalStreamIpc(client: BackendClient, trusted: TrustedSender): () => void {
  const streams = new Map<number, TerminalStreamConnection>();
  const lookup = (window: number, scope: string, input: TaskTerminalAttachment): TerminalStreamConnection | undefined => {
    if (client.state(window).scope?.id !== scope) return undefined;
    const stream = streams.get(window);
    return stream?.scope === scope && stream.target.taskId === input.taskId &&
      stream.target.terminalId === input.terminalId && stream.target.attachmentId === input.attachmentId ? stream : undefined;
  };
  const stops = [handleForWindow('task-terminal:attach', trusted, async (window, scope, raw) => {
    generation(scope);
    const value = object(raw); keys(value, ['taskId', 'terminalId', 'attachmentId', 'generation', 'after']);
    const target: TaskTerminalAttach = { ...attachment(raw), generation: value['generation'] === null ? null : generation(value['generation']), after: integer(value['after']) };
    const lease = client.lease(window, scope);
    if (!lease.ok) return lease;
    streams.get(window)?.close();
    const connection = connectTerminalStream(scope, target, lease.value, packet => {
      if (client.state(window).scope?.id === scope) sendToWindow(window, 'task-terminal:stream', {
        taskId: target.taskId, terminalId: target.terminalId, attachmentId: target.attachmentId, scopeId: scope, packet,
      });
    }, stream => { if (streams.get(window) === stream) streams.delete(window); });
    if (!connection.ok) return connection;
    streams.set(window, connection.value);
    return connection.value.ready;
  })];
  stops.push(handleForWindow('task-terminal:detach', trusted, (window, scope, input) => {
    keys(object(input), ['taskId', 'terminalId', 'attachmentId']);
    generation(scope); lookup(window, scope, attachment(input))?.close();
  }));
  stops.push(handleForWindow('task-terminal:stream-write', trusted, (window, scope, raw) => {
    generation(scope); const value = object(raw);
    keys(value, ['taskId', 'terminalId', 'attachmentId', 'generation', 'sequence', 'kind', 'data']);
    if ((value['kind'] !== 'text' && value['kind'] !== 'binary') || typeof value['data'] !== 'string' || !value['data'] ||
        value['data'].length > 4096 || Buffer.byteLength(value['data']) > 16384 ||
        // eslint-disable-next-line no-control-regex -- Binary input must contain only latin-1 bytes.
        (value['kind'] === 'binary' && /[^\x00-\xff]/.test(value['data']))) throw new Error('Invalid terminal input');
    const input: TaskTerminalStreamWrite = { ...attachment(raw), generation: generation(value['generation']), sequence: integer(value['sequence'], 1), kind: value['kind'], data: value['data'] };
    return lookup(window, scope, input)?.write(input) ?? unavailable();
  }));
  stops.push(handleForWindow('task-terminal:stream-resize', trusted, (window, scope, raw) => {
    keys(object(raw), ['taskId', 'terminalId', 'attachmentId', 'cols', 'rows']);
    generation(scope); const input = attachment(raw), size = terminalSize(raw);
    const stream = lookup(window, scope, input);
    if (!stream || stream.socket.readyState !== WebSocket.OPEN) return unavailable();
    stream.socket.send(JSON.stringify({ type: 'resize', ...size })); return accepted;
  }));
  stops.push(handleForWindow('task-terminal:stream-focus', trusted, (window, scope, raw) => {
    keys(object(raw), ['taskId', 'terminalId', 'attachmentId']);
    generation(scope); const stream = lookup(window, scope, attachment(raw));
    if (!stream || stream.socket.readyState !== WebSocket.OPEN) return unavailable();
    stream.socket.send(JSON.stringify({ type: 'focus' })); return accepted;
  }));
  stops.push(handleForWindow('task-terminal:stream-ack', trusted, (window, scope, raw) => {
    keys(object(raw), ['taskId', 'terminalId', 'attachmentId', 'delivery']);
    generation(scope); const value = object(raw);
    lookup(window, scope, attachment(raw))?.acknowledge(integer(value['delivery'], 1));
  }));
  stops.push(handleForWindow('task-terminal:context', trusted, (window, scope, raw) => {
    generation(scope); const value = object(raw); keys(value, ['taskId', 'terminalId', 'generation']);
    const task = integer(value['taskId'], 1), id = integer(value['terminalId'], 1), gen = generation(value['generation']);
    return client.execute(window, scope, `terminal:context:${task}:${id}:${gen}`, false, async (endpoint, signal) => {
      const reply = object(await requestBackendJson(endpoint, { path: `/api/desktop-workspace/tasks/${task}/terminals/${id}/context?generation=${gen}`, limit: 65536 }, signal));
      if (typeof reply['text'] !== 'string' || reply['text'].length > 8000) throw invalidResponse();
      return reply['text'];
    });
  }));
  return () => { for (const stop of stops) stop(); for (const stream of [...streams.values()]) stream.close(); };
}
