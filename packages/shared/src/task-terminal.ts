/** User-owned task shells. Attachment and reads never launch a process. */
export interface TaskTerminalTarget {
  readonly taskId: number;
  readonly terminalId: number;
}
export type TaskTerminalShellIntegration = 'pending' | 'active' | 'disabled' | 'unsupported' | 'unavailable';
export interface TaskTerminalServiceAddress {
  readonly port: number;
  /** A loopback address selected from an owned TCP listener. */
  readonly host: string;
  readonly protocol: 'http' | 'https';
  /** Confined pathname hint; never an output-supplied origin, query or fragment. */
  readonly path: string;
}
export interface TaskTerminal {
  readonly id: number;
  readonly taskId: number;
  readonly title: string;
  /** Optional display-only activity label; null restores the saved title. */
  readonly activityTitle?: string | null;
  readonly cwd: string;
  readonly branch: string;
  /** Null after server restart: an explicit new terminal is required. */
  readonly generation: string | null;
  readonly sequence: number;
  readonly alive: boolean;
  readonly status:
    | "idle"
    | "running"
    | "serving"
    | "failed"
    | "exited"
    | "unavailable";
  readonly command: string;
  readonly exitCode: number | null;
  readonly port: number | null;
  readonly protocol?: "http" | "https";
  /** Optional on older engines. At most 16 actual owned listening ports. */
  readonly services?: readonly TaskTerminalServiceAddress[];
  readonly portDiscovery?: 'pending' | 'process' | 'unavailable';
  readonly canRerun: boolean;
  /** Optional on older engines; never required for terminal input/output. */
  readonly shellIntegration?: TaskTerminalShellIntegration;
  /** Observed directory; null when unknown. cwd remains the launch workspace. */
  readonly currentCwd?: string | null;
  /** Capability for the separate bounded command metadata read. */
  readonly commandTracking?: true;
}
export interface TaskTerminalScript {
  readonly id: string;
  readonly name: string;
  readonly cmd: string;
}
export interface TaskTerminalList {
  readonly taskId: number;
  readonly terminals: readonly TaskTerminal[];
  readonly scripts: readonly TaskTerminalScript[];
  readonly limit: number;
  readonly shellIntegrationControl?: boolean;
}
export interface TaskTerminalRead extends TaskTerminalTarget {
  readonly generation: string | null;
  readonly after: number;
}
export interface TaskTerminalSize {
  readonly cols: number;
  readonly rows: number;
}
export interface TaskTerminalOutput {
  readonly terminal: TaskTerminal;
  readonly generation: string | null;
  readonly from: number;
  readonly next: number;
  readonly data: string;
  readonly gap: boolean;
  readonly more: boolean;
  /** PTY geometry for this output page. Absent on older engines. */
  readonly size?: TaskTerminalSize;
  /** Authenticated output-start boundaries within this page, at most 201. */
  readonly commandStarts?: readonly { readonly id: number; readonly at: number }[];
}
export interface TaskTerminalCreate {
  readonly taskId: number;
  readonly scriptId?: string;
  /** False starts the user's ordinary shell without injecting command hooks. */
  readonly shellIntegration?: boolean;
}
export interface TaskTerminalInput extends TaskTerminalTarget {
  readonly generation: string;
  readonly data: string;
}
export interface TaskTerminalResize extends TaskTerminalTarget {
  readonly generation: string;
  readonly cols: number;
  readonly rows: number;
}
export interface TaskTerminalAction extends TaskTerminalTarget {
  readonly generation: string;
  readonly type: "interrupt" | "rerun";
}
/** Browser owner receives the originating machine and port, never an output-supplied URL. */
export interface TerminalBrowserIntent {
  readonly scopeId: string;
  readonly taskId: number;
  readonly terminalId: number;
  readonly port: number;
}

/** Shell-reported metadata. Offsets refer to this process generation's output,
 * not screen rows; missing start hooks leave timing/start offsets null. */
export interface TaskTerminalCommand {
  readonly id: number;
  readonly command: string | null;
  readonly confidence: 'exact' | 'history' | 'unavailable';
  readonly cwd: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly outputStart: number | null;
  readonly outputEnd: number | null;
  readonly exitCode: number | null;
  readonly state: 'running' | 'completed' | 'interrupted';
}
export interface TaskTerminalCommandsRead extends TaskTerminalTarget {
  readonly generation: string | null;
  /** Last immutable completed command ID, initially zero. */
  readonly after: number;
}
export interface TaskTerminalCommands extends TaskTerminalTarget {
  readonly generation: string | null;
  readonly commands: readonly TaskTerminalCommand[];
  readonly current: TaskTerminalCommand | null;
  readonly next: number;
  readonly more: boolean;
  readonly gap: boolean;
}
