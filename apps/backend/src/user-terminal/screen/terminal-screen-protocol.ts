/** Private worker protocol. Offsets count UTF-16 units, matching the existing PTY API. */
export type ScreenCommand =
  | { type: 'open'; id: number; cols: number; rows: number }
  | { type: 'write'; id: number; data: string; next: number }
  | { type: 'resize'; id: number; cols: number; rows: number }
  | { type: 'snapshot' | 'context'; id: number; request: number }
  | { type: 'close'; id: number };
export type ScreenRequest = ScreenCommand & { readonly incarnation: number };

export interface ScreenSnapshot {
  readonly sequence: number;
  readonly cols: number;
  readonly rows: number;
  readonly data: string;
}
export type ScreenResponse =
  | { type: 'consumed'; id: number; incarnation: number; length: number }
  | { type: 'reply'; id: number; incarnation: number; data: string }
  | { type: 'result'; request: number; value: ScreenSnapshot | string }
  | { type: 'failure'; request: number; message: string };
