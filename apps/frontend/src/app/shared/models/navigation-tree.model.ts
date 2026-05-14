import { SessionInTree } from './session.model';
import { Workspace } from './workspace.model';
import { BranchInfo } from './branch.model';

export interface NavigationWorkspace extends Workspace {
  sessions: SessionInTree[];
  archivedSessions?: SessionInTree[];
}

export interface NavigationBranch extends BranchInfo {
  sessions: SessionInTree[];
  archivedSessions?: SessionInTree[];
}

export interface NavigationRepo {
  id: number;
  name: string;
  path: string;
  color?: string | null;
  error?: boolean;
  errorMessage?: string;
  workspaces?: NavigationWorkspace[];
  branches: NavigationBranch[];
}

export interface NavigationProject {
  id: number;
  name: string;
  repos: NavigationRepo[];
}
