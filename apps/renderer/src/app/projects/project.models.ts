import type { ProjectHue } from '../tasks/task.models';

export type ProjectLook = 'letters' | 'emoji' | 'icon';
export type NewProjectStep = 'repos' | 'name' | 'look';
export interface ProjectAppearance {
  readonly name: string;
  readonly look?: ProjectLook;
  readonly emoji?: string;
  readonly icon?: string;
  /** Omit to derive the hue from the project name until the user picks one. */
  readonly hue?: ProjectHue | null;
}
export interface FolderEntry {
  readonly path: string;
  readonly name?: string;
  readonly git?: string | null;
  readonly branch?: string | null;
  readonly dir?: boolean;
  readonly clone?: string;
}
/** The owner lists one supplied folder level. Requests are aborted when stale. */
export type FolderProvider = (query: string, signal: AbortSignal) => readonly FolderEntry[] | Promise<readonly FolderEntry[]>;
/** The owner checks all project names, including archived projects, in its current scope. */
export type ProjectNameProvider = (name: string, signal: AbortSignal) => boolean | Promise<boolean>;
export interface NewProjectRepo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly branch?: string | null;
  readonly clone?: string | null;
  readonly initialize?: boolean;
}
export interface NewProjectResult extends ProjectAppearance {
  readonly repos: readonly NewProjectRepo[];
  readonly look: ProjectLook;
  readonly hue: ProjectHue;
}
export interface NewProjectDraft extends ProjectAppearance {
  readonly repos?: readonly NewProjectRepo[];
  readonly step?: NewProjectStep;
  readonly query?: string;
  readonly listOpen?: boolean;
}
/** The card supplies DOM anchors solely for the owning view's launch animation. */
export interface CreateProjectIntent {
  readonly project: NewProjectResult;
  readonly card: HTMLElement;
}
export const PROJECT_HUES: readonly ProjectHue[] = ['ocean', 'pine', 'plum', 'rust', 'steel', 'rose'];
export const PROJECT_EMOJI = ['🦊', '🚀', '🧪', '🛒', '💳', '🛰️', '🌿', '🔥', '🧭', '🎯', '🐙', '⚡️'] as const;
export const PROJECT_ICONS = ['repo', 'code', 'globe', 'server', 'layers', 'bolt', 'shield', 'plug', 'bulb', 'workspace', 'terminal', 'grid'] as const;
