import type { ResultSummary } from './agent-tool-format';

type RecordValue = Record<string, unknown>;
export const PORT_FORWARDING_TOOL_NAMES = new Set([
  'list_port_forwards',
  'get_port_forward',
  'create_port_forward',
  'start_port_forward',
  'stop_port_forward',
  'remove_port_forward',
]);
export interface PortForwardReceiptRow {
  id: number;
  name: string;
  localAddress: string;
  remoteAddress: string;
  connection: string;
  status: ResultSummary;
  error: string;
  httpUrl?: string;
  creator?: { name: string; link: string };
}
export interface PortForwardingReceipt {
  forwards: PortForwardReceiptRow[];
  desktops: { id: string; label: string; mode: string }[];
  desktopLabel: string;
  target: string;
  summary: ResultSummary;
  notice: string;
  emptyText: string;
  reused: boolean;
  removed: boolean;
  more: boolean;
  needsAttention: boolean;
}
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function address(host: unknown, port: unknown): string {
  if (typeof port !== 'number') return '';
  const name = text(host) || 'localhost';
  return `${name.includes(':') && !name.startsWith('[') ? `[${name}]` : name}:${port}`;
}
/** Only local HTTP convenience links, with the recorded port, can be opened. */
export function desktopHttpUrl(value: unknown, port: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port || 80) === port &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}
function listenerStatus(data: RecordValue): ResultSummary {
  switch (data['status']) {
    case 'active':
      return { text: 'Listening', tone: 'ok' };
    case 'connecting':
      return { text: 'Connecting', tone: 'warn' };
    case 'stopping':
      return { text: 'Stopping', tone: 'warn' };
    case 'error':
      return {
        text: data['running'] === true ? 'Listener needs attention' : 'Could not start',
        tone: 'error',
      };
    default:
      return { text: 'Stopped', tone: 'neutral' };
  }
}
export function portForwardingReceipt(
  tool: string,
  args: RecordValue,
  data: RecordValue,
): PortForwardingReceipt {
  const rawForwards = Array.isArray(data['forwards']) ? data['forwards'] : [];
  const forwards = rawForwards.slice(0, 20).map((value) => {
    const row = record(value),
      creator = record(row['createdBySession']);
    return {
      id: typeof row['id'] === 'number' ? row['id'] : 0,
      name: text(row['name']) || 'Port forward',
      localAddress: address(row['bindAddress'], row['localPort']),
      remoteAddress: address(row['remoteHost'], row['remotePort']),
      connection: text(row['connectionLabel']),
      status: listenerStatus(row),
      error: text(row['lastError']),
      httpUrl:
        data['removed'] !== true && row['running'] === true
          ? desktopHttpUrl(row['localUrl'], row['localPort'])
          : undefined,
      ...(typeof creator['sessionId'] === 'number' &&
      Number.isSafeInteger(creator['sessionId']) &&
      creator['sessionId'] > 0
        ? {
            creator: {
              name: text(creator['sessionName']) || 'Agent conversation',
              link: `/sessions/${creator['sessionId']}`,
            },
          }
        : {}),
    };
  });
  const desktop = record(data['desktop']);
  const desktops =
    data['selectionRequired'] === true && Array.isArray(data['desktops'])
      ? data['desktops'].slice(0, 20).map((value) => {
          const item = record(value);
          return {
            id: text(item['desktopId']),
            label: text(item['connectionLabel']),
            mode:
              item['mode'] === 'paired'
                ? 'Paired desktop'
                : item['mode'] === 'ssh'
                  ? 'SSH'
                  : 'Local desktop',
          };
        })
      : [];
  let summary: ResultSummary = forwards[0]?.status ?? {
    text: 'Response received',
    tone: 'neutral',
  };
  let notice = 'Snapshot of the desktop listener. Ports shows current status; remote service readiness is separate.';
  let emptyText = '';
  if (data['removed'] === true) {
    summary = { text: 'Forward removed', tone: 'ok' };
    notice =
      'The listener and saved definition were removed. The remote application keeps running.';
  } else if (data['available'] === false) {
    summary = { text: 'Desktop not connected', tone: 'warn' };
    notice =
      'Open Elevenex on the backend where the agent is working. Desktop port forwarding requires a connected desktop app.';
  } else if (data['selectionRequired'] === true) {
    summary = { text: 'Choose a desktop', tone: 'warn' };
    notice = 'Several desktops are connected. The agent must select where to open the local port.';
  } else if (tool === 'list_port_forwards') {
    const count = rawForwards.length;
    const errors = rawForwards.filter((row) => record(row)['status'] === 'error').length;
    const total =
      typeof data['total'] === 'number' && data['total'] > count ? ` of ${data['total']}` : '';
    summary = {
      text: `${count}${total} forward${count === 1 && !total ? '' : 's'}${errors ? ` · ${errors} need attention` : ''}`,
      tone: errors ? 'warn' : 'neutral',
    };
    if (!count) emptyText = 'No port forwards are saved for this project on the selected desktop.';
  } else if (tool === 'stop_port_forward') {
    const stopped = forwards[0]?.status.text === 'Stopped';
    summary = stopped ? { text: 'Forward stopped', tone: 'ok' }
      : summary.tone === 'error' ? summary
        : { text: forwards[0]?.status.text === 'Stopping' ? 'Stopping' : 'Still listening', tone: 'warn' };
    notice = stopped ? 'The saved setup remains available in Ports. The remote application keeps running.'
      : 'The listener has not stopped yet. Open Ports for the current state.';
  } else if (data['reused'] === true) {
    summary = { ...summary, text: `Existing forward · ${summary.text.toLowerCase()}` };
  } else if (tool === 'create_port_forward' && forwards[0]?.status.text === 'Stopped') {
    summary = { text: 'Saved · Not started', tone: 'neutral' };
  }
  const target = forwards[0]
    ? `${forwards[0].localAddress} → ${forwards[0].remoteAddress}`
    : typeof args['remotePort'] === 'number'
      ? `${args['localPort'] ?? args['remotePort']} → ${address(args['remoteHost'], args['remotePort'])}`
      : typeof args['forwardId'] === 'number'
        ? `Forward #${args['forwardId']}`
        : 'Project ports';
  return {
    forwards,
    desktops,
    desktopLabel: text(desktop['connectionLabel']),
    target,
    summary,
    notice,
    emptyText,
    reused: data['reused'] === true,
    removed: data['removed'] === true,
    more: rawForwards.length > forwards.length || data['nextOffset'] != null,
    needsAttention:
      data['removed'] !== true &&
      (rawForwards.some((forward) => record(forward)['status'] === 'error') ||
        data['available'] === false ||
        data['selectionRequired'] === true),
  };
}
