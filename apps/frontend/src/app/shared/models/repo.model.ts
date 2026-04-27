export interface Repo {
  id: number;
  projectId: number;
  name: string;
  path: string;
  color?: string | null;
  preferredContextRootRef?: string | null;
  createdAt: string;
}
