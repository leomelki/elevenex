import type { ProjectMark, Repo } from '../../tasks/task.models';
import type { ProjectLook } from '../project.models';

export type ProjectSettingsSection = 'general' | 'repos' | 'tasks' | 'agents' | 'git';
export interface ProjectSettingsProject extends ProjectMark {
  readonly id?: string;
  readonly look?: ProjectLook;
}
export interface ProjectRepository extends Repo {
  readonly id: string;
  readonly path: string;
  readonly setup?: string;
  readonly check?: string;
  readonly tasks?: number;
  readonly sync?: string;
  /** Supplied branch names; the renderer never enumerates branches. */
  readonly branches?: readonly string[];
}
export interface RepositorySettingsPatch {
  readonly short?: string;
  readonly base?: string;
  readonly setup?: string;
  readonly check?: string;
}
export interface RepositorySettingsChange {
  readonly repo: ProjectRepository;
  readonly patch: RepositorySettingsPatch;
}
export type GitHelperPreference = 'auto' | 'ask' | 'never';
export interface ProjectPreferences {
  readonly prefix?: string;
  readonly newTasks?: 'active' | 'planned';
  readonly suggestClosing?: boolean;
  readonly cleanWorkspaces?: boolean;
  readonly defaultPreset?: string;
  readonly gitPreset?: string;
  readonly helpers?: GitHelperPreference;
  readonly subtaskMerge?: 'squash' | 'merge' | 'rebase';
}
