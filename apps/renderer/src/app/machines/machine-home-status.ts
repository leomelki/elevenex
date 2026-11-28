import type { Machine } from './machine.models';

/** Shared Home priority and wording; clicking the status points at machineId. */
export function machineHomeStatus(machines: readonly Machine[], pendingId?: string | null) {
  const failed = machines.find(machine => !machine.busy && machine.error);
  if (failed) return { machineId: failed.id, key: `error-${failed.id}`, tone: 'warn' as const, icon: failed.error!.tone === 'danger' ? 'shield' : 'wifi',
    text: failed.kind === 'local' ? /download|offline|network|fetch/i.test(failed.error!.step) ? "Couldn't download the engine" : "Couldn't get the engine ready" : `Couldn't reach ${failed.name}`, progress: undefined };
  const machine = machines.find(machine => machine.id === pendingId && machine.busy) ?? machines.find(machine => machine.busy);
  if (!machine?.busy) return null;
  const progress = machine.busy.progress;
  return { machineId: machine.id, key: `prepare-${machine.id}`, tone: 'info' as const, icon: machine.kind === 'local' ? 'download' : 'server',
    text: `${machine.kind === 'local' ? 'Getting ready' : `Setting up ${machine.name}`}${progress === undefined ? '' : ` ${Math.round(progress * 100)}%`}`, progress };
}
