import { SessionInTree } from './session.model';
import { Workspace } from './workspace.model';

export interface NavigationWorkspace extends Workspace {
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
  workspaces: NavigationWorkspace[];
}

export interface NavigationProject {
  id: number;
  name: string;
  repos: NavigationRepo[];
}
