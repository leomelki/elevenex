import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface FileTreeNode {
  key: string; // Relative path from worktree root
  label: string;
  data: { type: 'file' | 'directory'; path: string }; // Relative path
  children?: FileTreeNode[]; // Empty array for directories (lazy-loaded)
  leaf?: boolean;
}

@Injectable({ providedIn: 'root' })
export class FilesService {
  private http = inject(HttpClient);

  /**
   * List files in a worktree at a specific directory level.
   * @param worktreePath - Absolute path to the worktree
   * @param dirPath - Optional relative path to a subdirectory to list
   */
  listFiles(worktreePath: string, dirPath?: string): Observable<FileTreeNode[]> {
    const encoded = encodeURIComponent(worktreePath);
    let url = `/api/worktrees/${encoded}/files`;
    if (dirPath) {
      url += `?dir=${encodeURIComponent(dirPath)}`;
    }
    return this.http.get<FileTreeNode[]>(url);
  }

  readFile(worktreePath: string, filePath: string): Observable<{ content: string; language: string }> {
    const encodedWorktree = encodeURIComponent(worktreePath);
    const encodedFile = encodeURIComponent(filePath);
    return this.http.get<{ content: string; language: string }>(
      `/api/worktrees/${encodedWorktree}/files/${encodedFile}`
    );
  }

  writeFile(worktreePath: string, filePath: string, content: string): Observable<{ success: boolean }> {
    const encodedWorktree = encodeURIComponent(worktreePath);
    const encodedFile = encodeURIComponent(filePath);
    return this.http.put<{ success: boolean }>(
      `/api/worktrees/${encodedWorktree}/files/${encodedFile}`,
      { content }
    );
  }
}