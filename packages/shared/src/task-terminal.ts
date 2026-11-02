/** User-owned task shells. Attachment and reads never launch a process. */
export interface TaskTerminalTarget {
  readonly taskId: number;
  readonly terminalId: number;
}
export interface TaskTerminal {
  readonly id: number;
  readonly taskId: number;
  readonly title: string;
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
  readonly canRerun: boolean;
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
}
export interface TaskTerminalRead extends TaskTerminalTarget {
  readonly generation: string | null;
  readonly after: number;
}
export interface TaskTerminalOutput {
  readonly terminal: TaskTerminal;
  readonly generation: string | null;
  readonly from: number;
  readonly next: number;
  readonly data: string;
  readonly gap: boolean;
  readonly more: boolean;
}
export interface TaskTerminalCreate {
  readonly taskId: number;
  readonly scriptId?: string;
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
