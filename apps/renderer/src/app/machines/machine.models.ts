import type { ProgressStep } from '../ui';

export type MachineKind ='local' | 'ssh' | 'peer';
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
  readonly hue?: MachineColor;
  readonly host?: string;
  readonly user?: string;
  readonly port?: number;
  /** Display label; credentials and identity file permissions belong to main. */
  readonly key?: string;
  readonly paired?: string;
  readonly windows?: number;
  readonly update?: string;
  readonly error?: { readonly step: string; readonly tone?: 'warn' | 'danger'; readonly progress?: number; readonly action?: string };
  readonly busy?: { readonly step: string; readonly progress?: number; readonly meta?: string };
  /** A Windows engine running without the desktop session; apps stay off until it moves there. */
  readonly backgroundSession?: true;
}

export type AddMachineKind = Exclude<MachineKind, 'local'>;

export type AddMachineIntent =
  | { readonly kind: 'ssh'; readonly host: PickedHost; readonly fingerprint: string; readonly keyType: string; readonly replaced: boolean }
  | { readonly kind: 'peer'; readonly computer: PairedComputer; readonly text: string };

export interface MachineOpenEvent {
  readonly machine: Machine;
  readonly newWindow: boolean;
}

export interface MachineMenuEvent {
  readonly machine: Machine;
  readonly x: number;
  readonly y: number;
  readonly card: HTMLElement;
  readonly fromButton: boolean;
}

export interface MachineEditPatch {
  readonly name: string;
  readonly hue: MachineColor;
  readonly host?: string;
  readonly user?: string;
  readonly port?: number;
  readonly key?: string;
}

export interface MachineGuest {
  readonly id: string;
  readonly name: string;
  readonly since: string;
}

/** Machine readiness uses the shared step vocabulary. */
export type ReadyStep = ProgressStep;

export interface SshHost {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
}

export interface PickedHost {
  readonly name: string;
  readonly user: string;
  readonly port?: number;
  /** Resolved config may select a non-default port without exposing its value. */
  readonly portLabel?: string;
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
