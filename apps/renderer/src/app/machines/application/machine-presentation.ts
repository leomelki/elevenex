import type { BackendStatus, EnvironmentSelection, MachineState, RemoteConnectionStatus, RemoteHostInput } from '@elevenex/shared';
import type { Machine, ReadyStep } from '../index';

export const machineId = (selection: EnvironmentSelection): string => selection.kind === 'local' ? 'local' : selection.hostId;
export const machineSelection = (id: string): EnvironmentSelection => id === 'local' ? { kind: 'local' } : { kind: 'remote', hostId: id };
const failureStep = (message: string): string => message.split(/[.!?](?:\s|$)/, 1)[0] || message;
const progress = (received: number, total: number | null): number | undefined => total && total > 0 ? Math.min(1, Math.max(0, received / total)) : undefined;

export function localMachine(status: BackendStatus, name: string): Machine {
  const base = { id: 'local', name, kind: 'local', color: 'pine', address: 'Agents and files stay on this computer' } as const;
  switch (status.phase) {
    case 'ready': return { ...base, conn: 'live', status: 'Ready to work' };
    case 'failed': return { ...base, conn: 'fail', last: status.message, error: { step: failureStep(status.message) } };
    case 'stopped': case 'stopping': return { ...base, conn: 'idle', last: 'Engine stopped · open to restart' };
    case 'downloading': return { ...base, conn: 'idle', busy: { step: 'Downloading the engine', progress: progress(status.receivedBytes, status.totalBytes), meta: `${(status.receivedBytes / 1024 / 1024).toFixed(1)} MB` } };
    default: return { ...base, conn: 'idle', busy: { step: status.phase === 'extracting' ? 'Installing the engine' : status.phase === 'starting' ? 'Starting Elevenex' : 'Checking the engine' } };
  }
}

export function remotePresentation(connection: RemoteConnectionStatus): Pick<Machine, 'conn' | 'status' | 'last' | 'busy' | 'error'> {
  if (connection.phase === 'ready') return { conn: 'live', status: 'Ready to work' };
  if (connection.phase === 'paused' || connection.phase === 'disconnected') return { conn: connection.failure ? 'fail' : 'idle', last: connection.failure?.message ?? 'Open to connect', error: connection.failure ? { step: failureStep(connection.failure.message), tone: connection.failure.code === 'host-trust' ? 'danger' : 'warn', progress: connection.progress ? progress(connection.progress.receivedBytes, connection.progress.totalBytes) : undefined, action: connection.failure.action === 'verify-host' ? 'Review the key' : 'Try again' } : undefined };
  const labels: Record<RemoteConnectionStatus['stage'], string> = {
    authentication: connection.phase === 'awaiting-input' ? 'Waiting for your sign-in' : 'Connecting over SSH',
    discovery: 'Checking the server', download: 'Downloading the engine', installation: 'Installing the engine', runtime: 'Starting the engine', transport: 'Connecting', application: 'Starting Elevenex',
  };
  return { conn: 'idle', busy: { step: connection.phase === 'recovering' ? 'Reconnecting' : labels[connection.stage],
    progress: connection.progress ? progress(connection.progress.receivedBytes, connection.progress.totalBytes) : undefined } };
}

export function presentMachines(state: MachineState, localName: string): readonly Machine[] {
  const shared = new Map(state.remoteMachines.map(machine => [machine.hostId, machine]));
  return [{ ...localMachine(state.localBackend, state.localAppearance?.name ?? localName), ...(state.localAppearance ? { hue: state.localAppearance.hue } : {}) }, ...state.hosts.map((host): Machine => {
    const presence = shared.get(host.id);
    const connection = state.environment.selection.kind === 'remote' && state.environment.selection.hostId === host.id
      ? state.environment.connection : presence?.connection;
    return {
      id: host.id, name: host.name, kind: 'ssh', color: 'ocean', hue: host.hue,
      host: host.host, user: host.user, port: host.port, key: host.identityFile ? host.identityFile.split(/[\\/]/).pop() : undefined,
      address: `${host.user ? host.user + '@' : ''}${host.host}${host.port ? ':' + host.port : ''}`,
      windows: presence?.windows || undefined,
      ...(connection ? remotePresentation(connection) : { conn: 'idle', last: 'Open to connect' }),
    };
  })];
}

export function engineSteps(status: BackendStatus): readonly ReadyStep[] {
  const order = ['checking', 'downloading', 'extracting', 'starting', 'ready'];
  const index = order.indexOf(status.phase);
  return [
    { id: 'checking', label: 'Check the engine' }, { id: 'downloading', label: 'Download the engine' },
    { id: 'extracting', label: 'Install the engine' }, { id: 'starting', label: 'Start Elevenex' },
  ].map((step, at) => ({ ...step, state: at < index ? 'done' : at === index ? 'active' : 'todo',
    progress: step.id === 'downloading' && status.phase === 'downloading' ? progress(status.receivedBytes, status.totalBytes) : undefined }));
}

export function remoteEngineSteps(status: RemoteConnectionStatus): readonly ReadyStep[] {
  const order = ['discovery', 'download', 'installation', 'runtime', 'transport', 'application'];
  const index = order.indexOf(status.stage);
  return [
    { id: 'download', label: 'Download the engine' }, { id: 'installation', label: 'Install the engine' },
    { id: 'runtime', label: 'Start the engine' }, { id: 'application', label: 'Connect to Elevenex' },
  ].map(step => ({ ...step, state: order.indexOf(step.id) < index ? 'done' : order.indexOf(step.id) === index ? 'active' : 'todo',
    progress: step.id === 'download' && status.stage === 'download' && status.progress ? progress(status.progress.receivedBytes, status.progress.totalBytes) : undefined }));
}

/** Mirrors the destination grammar, never shell text. Main validates independently. */
export function parseSshDestination(value: string): RemoteHostInput | null {
  const match = /^(?:([a-zA-Z0-9_][a-zA-Z0-9_.@\\-]*)@)?(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9][a-zA-Z0-9._-]{0,252})(?::([0-9]{1,5}))?$/.exec(value.trim());
  if (!match?.[2]) return null;
  const port = match[3] ? Number(match[3]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  const host = match[2].replace(/^\[|\]$/g, '');
  return { name: value.trim(), host, ...(match[1] ? { user: match[1] } : {}), ...(port ? { port } : {}) };
}
