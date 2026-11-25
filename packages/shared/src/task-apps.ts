export const APP_INPUT_GUIDANCE = {
  permission:
    "Allow Accessibility for Elevenex App Display on the task Mac to control this window.",
  foreground:
    "Bring the owned app window to the foreground on the task machine to control it.",
} as const;

export const APP_VIDEO_MAX_AXIS = 4096;
export const APP_VIDEO_MAX_PIXELS = 4_194_304;
export const APP_VIDEO_MAX_BYTES = 3_000_000;

export const TASK_APP_SETUP_ISSUES = [
  "macos-screen-recording", "macos-accessibility", "macos-session", "macos-runtime",
  "windows-session", "windows-capture", "windows-runtime", "linux-display-tools", "linux-session",
] as const;
export type TaskAppSetupIssue = (typeof TASK_APP_SETUP_ISSUES)[number];

/** A task owns the run. Windows subscribe independently to its presentation. */
export interface TaskAppRun {
  readonly runId: string;
  readonly taskId: number;
  readonly name: string;
  readonly status:
    | "requested"
    | "starting"
    | "running"
    | "stopping"
    | "exited"
    | "failed";
  readonly mode: "native" | "stream";
  readonly startedAt: number;
  readonly pendingLaunch?: {
    readonly executable: string;
    readonly args: readonly string[];
  };
  readonly detail?: string;
  /** A prerequisite on the host, independent of the viewer's operating system. */
  readonly setupIssue?: TaskAppSetupIssue;
}

export type TaskAppInput =
  | {
      readonly kind: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button?: 0 | 1 | 2;
    }
  | {
      readonly kind: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    }
  | { readonly kind: "key"; readonly code: string; readonly down: boolean }
  | { readonly kind: "text"; readonly text: string };

export interface TaskAppFrame {
  readonly scopeId: string;
  readonly taskId: number;
  readonly runId: string;
  readonly watchId: string;
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly key: boolean;
  readonly timestamp: number;
  readonly codec: "avc1.42E02A";
  readonly data: Uint8Array;
}

export interface TaskAppClosed {
  readonly scopeId: string;
  readonly watchId: string;
  readonly reason: string;
}

export interface TaskAppWindowContext {
  readonly taskId: number;
  readonly runId: string;
}

/** Input coordinates are integer pixels in the fixed logical capture surface. */
export function validTaskAppInput(input: unknown): input is TaskAppInput {
  if (typeof input !== "object" || !input || !("kind" in input)) return false;
  const within = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (input.kind === "key")
    return (
      Object.keys(input).length === 3 &&
      "code" in input &&
      typeof input.code === "string" &&
      /^[A-Za-z0-9]{1,32}$/.test(input.code) &&
      "down" in input &&
      typeof input.down === "boolean"
    );
  if (input.kind === "text")
    return (
      Object.keys(input).length === 2 &&
      "text" in input &&
      typeof input.text === "string" &&
      input.text.length > 0 &&
      input.text.length <= 256 &&
      !input.text.includes("\0")
    );
  if (
    !(
      "x" in input &&
      "y" in input &&
      within(input.x, 0, 8191) &&
      within(input.y, 0, 8191)
    )
  )
    return false;
  if (input.kind === "wheel")
    return (
      Object.keys(input).length === 5 &&
      "deltaX" in input &&
      "deltaY" in input &&
      within(input.deltaX, -4096, 4096) &&
      within(input.deltaY, -4096, 4096)
    );
  if (input.kind === "move") return Object.keys(input).length === 3;
  return (
    (input.kind === "down" || input.kind === "up") &&
    Object.keys(input).length === 4 &&
    "button" in input &&
    within(input.button, 0, 2)
  );
}
