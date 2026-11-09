import type {
  BrowserAgentCommand,
  BrowserAgentState,
  TaskBrowserCommand,
  TaskBrowserLayout,
  TaskBrowserState,
  TaskBrowserStreamInput,
  TaskBrowserSurface,
} from "@elevenex/shared";
import type { BrowserWindow, WebContents } from "electron";
import type { BrowserCodeCommand, BrowserCodeResult } from '@elevenex/shared';

/** Task ownership API. Electron guest adoption and MCP execution are desktop-engine capabilities. */
export interface BrowserTaskHost {
  readonly scopeId: string;
  readonly taskId: number;
  readonly closed: boolean;
  restore(): Promise<void>;
  snapshot(): TaskBrowserState;
  command(input: TaskBrowserCommand): Promise<TaskBrowserState>;
  surfaces(): readonly TaskBrowserSurface[];
  presentation(tabId: string, value: "embedded" | "stream"): void;
  userInput(
    tabId: string,
    generation: number,
    input: TaskBrowserStreamInput,
  ): Promise<number>;
  acknowledge(tabId: string, streamId: string, sequence: number, decoded?: boolean): void;
  position(input: TaskBrowserLayout): void;
  applicationInput(x?: number, y?: number): void;
  maintain(): void;
  hide(): void;
  suspend(): void;
  revoke(): void;
  destroy(): void;
  hasDetached(): boolean;
  detachTab(tabId: string, window: BrowserWindow): void;
  returnTab(tabId: string): void;
  positionDetached(tabId: string, input: TaskBrowserLayout): void;
  hideDetached(tabId: string): void;
  applicationInputDetached(tabId: string, x?: number, y?: number): void;
  detachedSurfaces(tabId: string): readonly TaskBrowserSurface[];
  detachedSnapshot(tabId: string, state?: TaskBrowserState): TaskBrowserState;
}
export interface DesktopBrowserHost extends BrowserTaskHost {
  code(sessionId: number, command: BrowserCodeCommand, signal: AbortSignal): Promise<BrowserCodeResult>;
  readonly engine: "desktop";
  hasContents(tabId: string): boolean;
  attach(contents: WebContents, tabId: string): boolean;
  setPorts(ports: readonly number[]): void;
  agent(
    input: BrowserAgentCommand,
    sessionId: number,
    signal?: AbortSignal,
  ): Promise<BrowserAgentState>;
}
export interface MachineBrowserHost extends BrowserTaskHost {
  readonly engine: "machine";
  refresh(): Promise<void>;
}
export type BrowserHost = DesktopBrowserHost | MachineBrowserHost;
