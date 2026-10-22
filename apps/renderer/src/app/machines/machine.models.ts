export type MachineKind = 'local' | 'ssh' | 'peer';
export type MachineConnection = 'live' | 'kept' | 'idle' | 'fail';
export type MachineColor = 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';

export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly kind: MachineKind;
  readonly conn: MachineConnection;
  readonly address?: string;
  readonly status?: string;
  readonly last?: string;
  readonly color?: MachineColor;
  readonly windows?: number;
  readonly update?: string;
}

export interface MachineOpenEvent {
  readonly machine: Machine;
  readonly newWindow: boolean;
}

export interface MachineGuest {
  readonly id: string;
  readonly name: string;
  readonly since: string;
}

export interface ReadyStep {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly state: 'todo' | 'active' | 'done' | 'failed';
  readonly progress?: number;
  readonly meta?: string;
}

export interface SshHost {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

export interface PickedHost {
  readonly name: string;
  readonly user: string;
  readonly port?: number;
  readonly auth?: string;
  readonly fromConfig?: boolean;
}

export interface PairedComputer {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

export const MACHINE_ICON: Readonly<Record<MachineKind, string>> = {
  local: 'laptop', ssh: 'server', peer: 'peer',
};

export function machineConnected(machine: Machine): boolean {
  return machine.conn === 'live' || machine.conn === 'kept';
}

/** Progress marks are supplied in ascending order, each in the range (0, 1]. */
export function stagedSteps(progress: number, marks: readonly number[]): ReadonlyArray<'todo' | 'active' | 'done'> {
  const value = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return marks.map((mark, index) => value >= mark ? 'done' : value >= (marks[index - 1] ?? 0) ? 'active' : 'todo');
}
