import type { BackendStatus } from './index';
import type { EnvironmentSelection, EnvironmentSnapshot, RemoteConnectionStatus, RemoteHost } from './remote';

export type MachineHue = 'ocean' | 'pine' | 'plum' | 'rust' | 'steel' | 'rose';
export interface MachineAppearance { readonly name: string; readonly hue: MachineHue }
export interface MachineEditInput extends MachineAppearance {
  readonly host?: string;
  readonly user?: string;
  readonly port?: number;
  /** Undefined keeps the current choice; null restores OpenSSH defaults. */
  readonly identityFile?: string | null;
}
export interface MachineRemoval { readonly state: MachineState; readonly undoToken: string }

/** One ordered snapshot per window. Directory changes never initiate connections. */
export interface MachineState {
  readonly revision: number;
  readonly hasOpenedMachine: boolean;
  readonly settingsError: string | null;
  readonly localAppearance?: MachineAppearance;
  readonly hosts: readonly RemoteHost[];
  /** Shared connection presence; contains no other window's challenges or drafts. */
  readonly remoteMachines: readonly RemoteMachineSummary[];
  readonly localBackend: BackendStatus;
  readonly environment: EnvironmentSnapshot;
  /** An explicit card → new-window request; ordinary windows start on Home. */
  readonly launchSelection: EnvironmentSelection | null;
}

export interface RemoteMachineSummary {
  readonly hostId: string;
  readonly connection: RemoteConnectionStatus;
  readonly windows: number;
}

export interface SshHostSuggestion {
  readonly host: string;
}
