import { BranchInfo } from './branch.model';
import { SessionInTree } from './session.model';

export interface NavigationBranch extends BranchInfo {
  sessions: SessionInTree[];
}

export interface NavigationRepo {
  id: number;
  name: string;
  path: string;
  color?: string | null;
  error?: boolean;
  errorMessage?: string;
  branches: NavigationBranch[];
}

export interface NavigationProject {
  id: number;
  name: string;
  repos: NavigationRepo[];
}