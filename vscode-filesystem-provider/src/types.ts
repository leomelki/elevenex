/**
 * Backend API types for file operations
 * 
 * These interfaces match the NestJS backend FileController responses
 * from Phase 08 (apps/backend/src/files/files.controller.ts)
 */

/**
 * File metadata from backend stat endpoint
 * 
 * Backend endpoint: GET /api/files/:worktreeId/stat?path=...
 */
export interface BackendFileStat {
  type: 'file' | 'directory';
  ctime: number;  // Creation time in milliseconds
  mtime: number;  // Modification time in milliseconds
  size: number;   // Size in bytes
}

/**
 * Directory entry from backend list endpoint
 * 
 * Backend endpoint: GET /api/files/:worktreeId/list?path=...
 */
export interface BackendDirectoryEntry {
  name: string;
  type: 'file' | 'directory';
}

/**
 * Write request payload for backend write endpoint
 * 
 * Backend endpoint: PUT /api/worktrees/:worktreePath/files/*path
 */
export interface BackendWriteRequest {
  content: string;
}

export interface BackendFileSearchResult {
  path: string;
  name: string;
}

export interface BackendTextSearchRange {
  start: number;
  end: number;
}

export interface BackendTextSearchResult {
  path: string;
  lineNumber: number;
  lineText: string;
  ranges: BackendTextSearchRange[];
}

export interface BackendTextSearchOptions {
  query: string;
  isRegExp?: boolean;
  isCaseSensitive?: boolean;
  isWordMatch?: boolean;
  includes?: string[];
  excludes?: string[];
  useIgnoreFiles?: boolean;
  maxResults?: number;
}
