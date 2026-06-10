import { Injectable, BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
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

export interface FileSearchResult {
  path: string;
  name: string;
}

export interface TextSearchRange {
  start: number;
  end: number;
}

export interface TextSearchResult {
  path: string;
  lineNumber: number;
  lineText: string;
  ranges: TextSearchRange[];
}

export interface TextSearchOptions {
  query: string;
  isRegExp?: boolean;
  isCaseSensitive?: boolean;
  isWordMatch?: boolean;
  includes?: string[];
  excludes?: string[];
  useIgnoreFiles?: boolean;
  maxResults?: number;
}

const DEFAULT_FILE_SEARCH_LIMIT = 100;
const MAX_FILE_SEARCH_LIMIT = 500;
const FALLBACK_WALK_MAX_FILES = 20_000;
const DEFAULT_TEXT_SEARCH_LIMIT = 250;
const MAX_TEXT_SEARCH_LIMIT = 2_000;
const RIPGREP_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'darwin-arm64': '@vscode/ripgrep-darwin-arm64',
  'darwin-x64': '@vscode/ripgrep-darwin-x64',
  'linux-arm64': '@vscode/ripgrep-linux-arm64',
  'linux-arm': '@vscode/ripgrep-linux-arm',
  'linux-ia32': '@vscode/ripgrep-linux-ia32',
  'linux-ppc64': '@vscode/ripgrep-linux-ppc64',
  'linux-riscv64': '@vscode/ripgrep-linux-riscv64',
  'linux-s390x': '@vscode/ripgrep-linux-s390x',
  'linux-x64': '@vscode/ripgrep-linux-x64',
  'win32-arm64': '@vscode/ripgrep-win32-arm64',
  'win32-ia32': '@vscode/ripgrep-win32-ia32',
  'win32-x64': '@vscode/ripgrep-win32-x64',
};

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
  '.go': 'go',
  '.rs': 'rust',
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
export function isWithinWorktree(
  worktreePath: string,
  filePath: string,
): boolean {
  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedFile = path.resolve(filePath);
  const relativePath = path.relative(resolvedWorktree, resolvedFile);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function expandHomePath(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }

  if (inputPath === '~') {
    return os.homedir();
  }

  if (/^~[\\/]/.test(inputPath)) {
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

function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join('/');
}

function isSearchableRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('../') || normalized === '..') {
    return false;
  }

  return !normalized.split('/').some((segment) => segment === '.git');
}

function normalizeFileSearchLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_FILE_SEARCH_LIMIT;
  }

  return Math.max(1, Math.min(MAX_FILE_SEARCH_LIMIT, Math.floor(limit)));
}

function normalizeTextSearchLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_TEXT_SEARCH_LIMIT;
  }

  return Math.max(1, Math.min(MAX_TEXT_SEARCH_LIMIT, Math.floor(limit)));
}

function normalizeFileSearchQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\\/g, '/');
}

function normalizeGlobList(value?: string[]): string[] {
  return (value ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\\/g, '/'));
}

function resolveRipgrepBinary(): string {
  const packageName =
    RIPGREP_PLATFORM_PACKAGE_BY_TARGET[`${process.platform}-${process.arch}`];

  if (packageName) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`);
      const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
      return path.join(path.dirname(packageJsonPath), 'bin', binaryName);
    } catch {
      // Fall through to PATH lookup for development environments.
    }
  }

  return 'rg';
}

function byteOffsetToStringOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }

  return Buffer.from(text, 'utf8')
    .subarray(0, byteOffset)
    .toString('utf8').length;
}

function isFuzzyMatch(candidate: string, query: string): boolean {
  if (!query) {
    return true;
  }

  let queryIndex = 0;
  for (
    let index = 0;
    index < candidate.length && queryIndex < query.length;
    index += 1
  ) {
    if (candidate[index] === query[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === query.length;
}

function rankSearchPath(relativePath: string, query: string): number | null {
  const normalizedPath = relativePath.toLowerCase();
  const basename = path.posix.basename(normalizedPath);

  if (!query) {
    return 0;
  }

  if (basename.startsWith(query)) {
    return 0;
  }

  if (basename.includes(query)) {
    return 1;
  }

  if (normalizedPath.includes(query)) {
    return 2;
  }

  if (isFuzzyMatch(normalizedPath, query)) {
    return 3;
  }

  return null;
}

function runGitLsFiles(worktreePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-C',
        worktreePath,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      {
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') ||
              `git ls-files exited with code ${code}`,
          ),
        );
        return;
      }

      resolve(
        Buffer.concat(stdout)
          .toString('utf8')
          .split('\0')
          .filter(Boolean),
      );
    });
  });
}

async function resolveExistingParentDirectory(
  targetDirectory: string,
): Promise<{
  existingDirectory: string;
  missingSegments: string[];
}> {
  const resolvedTarget = path.resolve(targetDirectory);
  const parsed = path.parse(resolvedTarget);
  const relativeSegments =
    parsed.dir === parsed.root
      ? resolvedTarget.slice(parsed.root.length).split(path.sep).filter(Boolean)
      : path
          .relative(parsed.root, resolvedTarget)
          .split(path.sep)
          .filter(Boolean);

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
  async searchFiles(
    worktreePath: string,
    query: string = '',
    limit?: number,
  ): Promise<FileSearchResult[]> {
    const resolvedWorktree = path.resolve(worktreePath);
    let stat;
    try {
      stat = await fs.stat(resolvedWorktree);
    } catch {
      throw new BadRequestException(`Directory does not exist: ${worktreePath}`);
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path is not a directory: ${worktreePath}`);
    }

    const normalizedQuery = normalizeFileSearchQuery(query);
    const normalizedLimit = normalizeFileSearchLimit(limit);
    const candidates = await this.listSearchCandidatePaths(resolvedWorktree);

    return candidates
      .map((candidate) => {
        const relativePath = candidate.replace(/\\/g, '/');
        const rank = rankSearchPath(relativePath, normalizedQuery);
        return rank === null
          ? null
          : {
              rank,
              path: relativePath,
              name: path.posix.basename(relativePath),
            };
      })
      .filter(
        (item): item is FileSearchResult & { rank: number } => item !== null,
      )
      .sort((left, right) => {
        if (left.rank !== right.rank) {
          return left.rank - right.rank;
        }

        const leftName = left.name.toLowerCase();
        const rightName = right.name.toLowerCase();
        if (leftName !== rightName) {
          return leftName.localeCompare(rightName);
        }

        return left.path.localeCompare(right.path);
      })
      .slice(0, normalizedLimit)
      .map(({ path: resultPath, name }) => ({ path: resultPath, name }));
  }

  async searchText(
    worktreePath: string,
    options: TextSearchOptions,
  ): Promise<TextSearchResult[]> {
    const resolvedWorktree = path.resolve(worktreePath);
    let stat;
    try {
      stat = await fs.stat(resolvedWorktree);
    } catch {
      throw new BadRequestException(`Directory does not exist: ${worktreePath}`);
    }

    if (!stat.isDirectory()) {
      throw new BadRequestException(`Path is not a directory: ${worktreePath}`);
    }

    const query = options.query ?? '';
    if (!query) {
      return [];
    }

    const maxResults = normalizeTextSearchLimit(options.maxResults);
    const args = this.buildRipgrepTextSearchArgs(options);

    return new Promise((resolve, reject) => {
      const child = spawn(resolveRipgrepBinary(), args, {
        cwd: resolvedWorktree,
        windowsHide: true,
      });
      const results: TextSearchResult[] = [];
      let stdoutBuffer = '';
      let stderr = '';
      let didKillForLimit = false;
      let settled = false;

      const resolveOnce = (value: TextSearchResult[]): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const handleLine = (line: string): void => {
        if (!line.trim()) {
          return;
        }

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type !== 'match') {
          return;
        }

        const relativePath = String(event.data?.path?.text ?? '').replace(
          /\\/g,
          '/',
        ).replace(/^\.\//, '');
        const lineText = String(event.data?.lines?.text ?? '').replace(
          /\r?\n$/,
          '',
        );
        const lineNumber = Math.max(0, Number(event.data?.line_number ?? 1) - 1);
        const submatches = Array.isArray(event.data?.submatches)
          ? event.data.submatches
          : [];
        const ranges = submatches
          .map((submatch: any) => ({
            start: byteOffsetToStringOffset(
              lineText,
              Number(submatch.start ?? 0),
            ),
            end: byteOffsetToStringOffset(lineText, Number(submatch.end ?? 0)),
          }))
          .filter((range: TextSearchRange) => range.end >= range.start);

        if (!relativePath || ranges.length === 0) {
          return;
        }

        results.push({
          path: relativePath,
          lineNumber,
          lineText,
          ranges,
        });

        if (results.length >= maxResults && !didKillForLimit) {
          didKillForLimit = true;
          child.kill();
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          handleLine(line);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        rejectOnce(error);
      });

      child.on('close', (code, signal) => {
        if (stdoutBuffer) {
          handleLine(stdoutBuffer);
        }

        if (didKillForLimit || code === 0 || code === 1) {
          resolveOnce(results.slice(0, maxResults));
          return;
        }

        rejectOnce(
          new Error(
            stderr.trim() ||
              `ripgrep exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
          ),
        );
      });
    });
  }

  private buildRipgrepTextSearchArgs(options: TextSearchOptions): string[] {
    const args = [
      '--json',
      '--line-number',
      '--with-filename',
      '--no-heading',
      '--color',
      'never',
    ];

    if (!options.isRegExp) {
      args.push('--fixed-strings');
    }

    if (options.isCaseSensitive === true) {
      args.push('--case-sensitive');
    } else if (options.isCaseSensitive === false) {
      args.push('--ignore-case');
    }

    if (options.isWordMatch) {
      args.push('--word-regexp');
    }

    if (options.useIgnoreFiles === false) {
      args.push('--no-ignore');
    }

    for (const include of normalizeGlobList(options.includes)) {
      args.push('--glob', include);
    }

    for (const exclude of normalizeGlobList(options.excludes)) {
      args.push('--glob', `!${exclude}`);
    }

    args.push('--', options.query, '.');
    return args;
  }

  private async listSearchCandidatePaths(
    worktreePath: string,
  ): Promise<string[]> {
    try {
      const gitPaths = await runGitLsFiles(worktreePath);
      return gitPaths
        .map((item) => item.replace(/\\/g, '/'))
        .filter(isSearchableRelativePath);
    } catch {
      return this.walkSearchCandidatePaths(worktreePath);
    }
  }

  private async walkSearchCandidatePaths(
    worktreePath: string,
  ): Promise<string[]> {
    const results: string[] = [];
    const queue = [''];

    while (queue.length > 0 && results.length < FALLBACK_WALK_MAX_FILES) {
      const relativeDirectory = queue.shift()!;
      const absoluteDirectory = relativeDirectory
        ? path.join(worktreePath, relativeDirectory)
        : worktreePath;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }

        const relativePath = relativeDirectory
          ? `${toPosixPath(relativeDirectory)}/${entry.name}`
          : entry.name;

        if (entry.isDirectory()) {
          queue.push(relativePath);
          continue;
        }

        if (entry.isFile() && isSearchableRelativePath(relativePath)) {
          results.push(relativePath);
          if (results.length >= FALLBACK_WALK_MAX_FILES) {
            break;
          }
        }
      }
    }

    return results;
  }

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
    const exactParent = /[\\/]$/.test(trimmedInput) || trimmedInput === '~';

    const requestedDirectory = exactParent
      ? normalizedInput
      : path.dirname(normalizedInput);
    const requestedPrefix = exactParent ? '' : path.basename(normalizedInput);
    const { existingDirectory, missingSegments } =
      await resolveExistingParentDirectory(requestedDirectory);
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

      if (
        normalizedPrefix &&
        !entry.name.toLowerCase().startsWith(normalizedPrefix)
      ) {
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
  ): Promise<{
    type: 'file' | 'directory';
    ctime: number;
    mtime: number;
    size: number;
  }> {
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
  async listFiles(
    worktreePath: string,
    dirPath: string = '',
  ): Promise<FileTreeNode[]> {
    const targetDir = dirPath ? path.join(worktreePath, dirPath) : worktreePath;

    // Validate worktree exists
    try {
      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        throw new BadRequestException(
          `Path is not a directory: ${dirPath || worktreePath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BadRequestException(
          `Directory does not exist: ${dirPath || worktreePath}`,
        );
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

      const relativePath = relativeBase
        ? `${relativeBase}/${entry.name}`
        : entry.name;

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
