import { Injectable, BadRequestException } from '@nestjs/common';
import { promises as fs, Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface FileTreeNode {
  key: string; // Relative path from worktree root
  label: string; // File/directory name
  data: { type: 'file' | 'directory'; path: string }; // Relative path
  children?: FileTreeNode[];
  leaf?: boolean; // true for files
}

export type PathSuggestionKind = 'file' | 'directory';
export type PathSuggestionTargetKind = 'file' | 'directory' | 'either';

export interface PathSuggestion {
  path: string;
  name: string;
  kind: PathSuggestionKind;
  isExactParent: boolean;
  trailingSlashHint: boolean;
}

/**
 * Map file extensions to Monaco language IDs
 */
const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.py': 'python',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
};

/**
 * Detect language from file extension
 */
export function detectLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
}

/**
 * Validate that a file path is within the worktree directory.
 * Prevents path traversal attacks.
 */
export function isWithinWorktree(worktreePath: string, filePath: string): boolean {
  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile.startsWith(resolvedWorktree);
}

function expandHomePath(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === '~') {
    return os.homedir();
  }

  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function resolveExistingParentDirectory(targetDirectory: string): Promise<{
  existingDirectory: string;
  missingSegments: string[];
}> {
  const resolvedTarget = path.resolve(targetDirectory);
  const parsed = path.parse(resolvedTarget);
  const relativeSegments = parsed.dir === parsed.root
    ? resolvedTarget.slice(parsed.root.length).split(path.sep).filter(Boolean)
    : path.relative(parsed.root, resolvedTarget).split(path.sep).filter(Boolean);

  let cursor = parsed.root;

  for (let index = 0; index < relativeSegments.length; index += 1) {
    const candidate = path.join(cursor, relativeSegments[index]);
    if (!(await isDirectory(candidate))) {
      return {
        existingDirectory: cursor,
        missingSegments: relativeSegments.slice(index),
      };
    }
    cursor = candidate;
  }

  return {
    existingDirectory: resolvedTarget,
    missingSegments: [],
  };
}

@Injectable()
export class FilesService {
  async suggestPaths(
    rawInput: string,
    targetKind: PathSuggestionTargetKind = 'either',
    preferredStartDirectory?: string,
  ): Promise<PathSuggestion[]> {
    const fallbackInput = preferredStartDirectory?.trim() ?? '';
    const trimmedInput = rawInput.trim() || fallbackInput;
    if (!trimmedInput) {
      return [];
    }

    const expandedInput = expandHomePath(trimmedInput);
    const normalizedInput = path.isAbsolute(expandedInput)
      ? path.normalize(expandedInput)
      : path.resolve(expandedInput);
    const exactParent = trimmedInput.endsWith(path.sep) || trimmedInput === '~';

    const requestedDirectory = exactParent
      ? normalizedInput
      : path.dirname(normalizedInput);
    const requestedPrefix = exactParent ? '' : path.basename(normalizedInput);
    const { existingDirectory, missingSegments } = await resolveExistingParentDirectory(requestedDirectory);
    const effectivePrefix = missingSegments[0] ?? requestedPrefix;
    const includeHidden = effectivePrefix.startsWith('.');

    let entries: Dirent[];
    try {
      entries = await fs.readdir(existingDirectory, { withFileTypes: true });
    } catch {
      return [];
    }

    const normalizedPrefix = effectivePrefix.toLowerCase();
    const suggestions: PathSuggestion[] = [];

    for (const entry of entries) {
      const kind: PathSuggestionKind | null = entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : null;

      if (!kind) {
        continue;
      }

      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }

      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      if (targetKind === 'directory' && kind !== 'directory') {
        continue;
      }

      if (targetKind === 'file' && kind !== 'file') {
        continue;
      }

      if (normalizedPrefix && !entry.name.toLowerCase().startsWith(normalizedPrefix)) {
        continue;
      }

      suggestions.push({
        path: path.join(existingDirectory, entry.name),
        name: entry.name,
        kind,
        isExactParent: missingSegments.length === 0,
        trailingSlashHint: kind === 'directory',
      });
    }

    return suggestions.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }

  async stat(
    targetPath: string,
    worktreePath: string,
  ): Promise<{ type: 'file' | 'directory'; ctime: number; mtime: number; size: number }> {
    if (!isWithinWorktree(worktreePath, targetPath)) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    try {
      const result = await fs.stat(targetPath);
      return {
        type: result.isDirectory() ? 'directory' : 'file',
        ctime: result.ctimeMs,
        mtime: result.mtimeMs,
        size: result.size,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BadRequestException(`Path does not exist: ${targetPath}`);
      }
      throw error;
    }
  }

  /**
   * List files in a worktree at a specific directory level (non-recursive).
   * Excludes hidden files (starting with .) and node_modules.
   * Directories are sorted before files, both alphabetically.
   * @param worktreePath - Absolute path to the worktree root
   * @param dirPath - Relative path from worktree root to the directory to list
   */
  async listFiles(worktreePath: string, dirPath: string = ''): Promise<FileTreeNode[]> {
    const targetDir = dirPath ? path.join(worktreePath, dirPath) : worktreePath;

    // Validate worktree exists
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        throw new BadRequestException(`Path is not a directory: ${dirPath || worktreePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BadRequestException(`Directory does not exist: ${dirPath || worktreePath}`);
      }
      throw error;
    }

    return this.readDirectory(targetDir, worktreePath, dirPath);
  }

  /**
   * Read a single directory level (non-recursive).
   */
  private async readDirectory(
    dirPath: string,
    worktreePath: string,
    relativeBase: string,
  ): Promise<FileTreeNode[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      // Skip hidden files and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Directory: don't load children, just mark as expandable
        nodes.push({
          key: relativePath,
          label: entry.name,
          data: { type: 'directory', path: relativePath },
          children: [], // Empty array indicates it can be expanded
          leaf: false,
        });
      } else {
        nodes.push({
          key: relativePath,
          label: entry.name,
          data: { type: 'file', path: relativePath },
          leaf: true,
        });
      }
    }

    // Sort: directories first (leaf: false), then files (leaf: true), both alphabetically
    return nodes.sort((a, b) => {
      // Directories before files
      if (a.leaf !== b.leaf) {
        return a.leaf ? 1 : -1;
      }
      // Alphabetical by label
      return a.label.localeCompare(b.label);
    });
  }

  /**
   * Read file content from the filesystem.
   * Returns content and detected language.
   */
  async readFile(
    filePath: string,
    worktreePath: string,
  ): Promise<{ content: string; language: string }> {
    // Validate path is within worktree
    if (!isWithinWorktree(worktreePath, filePath)) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    // Check file exists
    try {
      await fs.access(filePath);
    } catch {
      throw new BadRequestException(`File does not exist: ${filePath}`);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const language = detectLanguage(filePath);

    return { content, language };
  }

  /**
   * Write content to a file within the worktree.
   * Creates parent directories if needed.
   */
  async writeFile(
    filePath: string,
    content: string,
    worktreePath: string,
  ): Promise<void> {
    // Validate path is within worktree
    if (!isWithinWorktree(worktreePath, filePath)) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    // Create parent directories if needed
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Write the file
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async createDirectory(dirPath: string, worktreePath: string): Promise<void> {
    if (!isWithinWorktree(worktreePath, dirPath)) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    await fs.mkdir(dirPath, { recursive: true });
  }

  async rename(
    oldPath: string,
    newPath: string,
    worktreePath: string,
    overwrite = false,
  ): Promise<void> {
    if (
      !isWithinWorktree(worktreePath, oldPath) ||
      !isWithinWorktree(worktreePath, newPath)
    ) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    try {
      await fs.access(oldPath);
    } catch {
      throw new BadRequestException(`Path does not exist: ${oldPath}`);
    }

    let destinationExists = false;

    try {
      await fs.access(newPath);
      destinationExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (destinationExists) {
      if (!overwrite) {
        throw new BadRequestException('Destination already exists');
      }

      await fs.rm(newPath, { recursive: true, force: true });
    }

    await fs.rename(oldPath, newPath);
  }

  async deleteEntry(
    targetPath: string,
    worktreePath: string,
    recursive: boolean,
  ): Promise<void> {
    if (!isWithinWorktree(worktreePath, targetPath)) {
      throw new BadRequestException('Access denied: path outside worktree');
    }

    try {
      await fs.access(targetPath);
    } catch {
      throw new BadRequestException(`Path does not exist: ${targetPath}`);
    }

    await fs.rm(targetPath, { recursive, force: false });
  }
}
