import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FilesService,
  detectLanguage,
  isWithinWorktree,
} from './files.service.js';

describe('FilesService', () => {
  let service: FilesService;
  let tmpDir: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FilesService],
    }).compile();

    service = module.get<FilesService>(FilesService);

    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('detectLanguage', () => {
    it('should detect TypeScript from .ts extension', () => {
      expect(detectLanguage('file.ts')).toBe('typescript');
    });

    it('should detect TypeScript from .tsx extension', () => {
      expect(detectLanguage('file.tsx')).toBe('typescript');
    });

    it('should detect JavaScript from .js extension', () => {
      expect(detectLanguage('file.js')).toBe('javascript');
    });

    it('should detect JSON from .json extension', () => {
      expect(detectLanguage('file.json')).toBe('json');
    });

    it('should detect Markdown from .md extension', () => {
      expect(detectLanguage('README.md')).toBe('markdown');
    });

    it('should detect Python from .py extension', () => {
      expect(detectLanguage('script.py')).toBe('python');
    });

    it('should detect Go from .go extension', () => {
      expect(detectLanguage('main.go')).toBe('go');
    });

    it('should detect Rust from .rs extension', () => {
      expect(detectLanguage('lib.rs')).toBe('rust');
    });

    it('should detect CSS from .css extension', () => {
      expect(detectLanguage('style.css')).toBe('css');
    });

    it('should detect YAML from .yaml extension', () => {
      expect(detectLanguage('config.yaml')).toBe('yaml');
    });

    it('should detect YAML from .yml extension', () => {
      expect(detectLanguage('config.yml')).toBe('yaml');
    });

    it('should return plaintext for unknown extensions', () => {
      expect(detectLanguage('file.unknown')).toBe('plaintext');
    });

    it('should return plaintext for files without extension', () => {
      expect(detectLanguage('Makefile')).toBe('plaintext');
    });

    it('should be case-insensitive', () => {
      expect(detectLanguage('FILE.TS')).toBe('typescript');
    });
  });

  describe('isWithinWorktree', () => {
    it('should return true for path within worktree', () => {
      expect(isWithinWorktree('/worktree', '/worktree/src/file.ts')).toBe(true);
    });

    it('should return true for worktree root itself', () => {
      expect(isWithinWorktree('/worktree', '/worktree')).toBe(true);
    });

    it('should return false for path outside worktree', () => {
      expect(isWithinWorktree('/worktree', '/other/file.ts')).toBe(false);
    });

    it('should return false for path traversal attempt', () => {
      expect(isWithinWorktree('/worktree', '/worktree/../other/file.ts')).toBe(
        false,
      );
    });

    it('should return false for paths that only share a prefix with the worktree', () => {
      expect(isWithinWorktree('/worktree', '/worktree-other/file.ts')).toBe(
        false,
      );
    });

    it('should allow child paths whose names start with dots', () => {
      expect(isWithinWorktree('/worktree', '/worktree/..cache/file.ts')).toBe(
        true,
      );
    });
  });

  describe('listFiles', () => {
    it('should throw BadRequestException for non-existent path', async () => {
      await expect(service.listFiles('/nonexistent')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if path is not a directory', async () => {
      const filePath = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      await expect(service.listFiles(filePath)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return empty array for empty directory', async () => {
      const result = await service.listFiles(tmpDir);
      expect(result).toEqual([]);
    });

    it('should return single-level directory structure (non-recursive)', async () => {
      // Create structure: tmpDir/src/index.ts, tmpDir/file.txt
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'content');
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      expect(result).toHaveLength(2);
      // First should be directory (src)
      expect(result[0].label).toBe('src');
      expect(result[0].leaf).toBe(false);
      expect(result[0].data.type).toBe('directory');
      expect(result[0].children).toEqual([]); // Empty, not loaded
      // Second should be file (file.txt)
      expect(result[1].label).toBe('file.txt');
      expect(result[1].leaf).toBe(true);
      expect(result[1].data.type).toBe('file');
    });

    it('should load subdirectory contents when dir parameter is provided', async () => {
      // Create structure: tmpDir/src/index.ts
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'content');

      // Load root
      const rootResult = await service.listFiles(tmpDir);
      expect(rootResult).toHaveLength(1);
      expect(rootResult[0].label).toBe('src');
      expect(rootResult[0].children).toEqual([]);

      // Load src directory
      const srcResult = await service.listFiles(tmpDir, 'src');
      expect(srcResult).toHaveLength(1);
      expect(srcResult[0].label).toBe('index.ts');
      expect(srcResult[0].leaf).toBe(true);
    });

    it('should exclude hidden files', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'content');
      fs.mkdirSync(path.join(tmpDir, '.hidden'));
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('visible.txt');
    });

    it('should exclude node_modules', async () => {
      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.mkdirSync(path.join(tmpDir, 'src'));

      const result = await service.listFiles(tmpDir);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe('src');
    });

    it('should sort directories before files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'zzz-file.txt'), 'content');
      fs.mkdirSync(path.join(tmpDir, 'aaa-dir'));
      fs.writeFileSync(path.join(tmpDir, 'mmm-file.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      // Directory should be first
      expect(result[0].label).toBe('aaa-dir');
      expect(result[0].leaf).toBe(false);
      // Then files sorted alphabetically
      expect(result[1].label).toBe('mmm-file.txt');
      expect(result[2].label).toBe('zzz-file.txt');
    });

    it('should sort items alphabetically within same type', async () => {
      fs.mkdirSync(path.join(tmpDir, 'z-dir'));
      fs.mkdirSync(path.join(tmpDir, 'a-dir'));
      fs.writeFileSync(path.join(tmpDir, 'z-file.txt'), 'content');
      fs.writeFileSync(path.join(tmpDir, 'a-file.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      // Directories sorted alphabetically
      expect(result[0].label).toBe('a-dir');
      expect(result[1].label).toBe('z-dir');
      // Files sorted alphabetically
      expect(result[2].label).toBe('a-file.txt');
      expect(result[3].label).toBe('z-file.txt');
    });

    it('should set correct key paths', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      expect(result[0].key).toBe('file.txt');
      expect(result[0].data.path).toBe('file.txt');
    });
  });

  describe('suggestPaths', () => {
    it('expands the home directory for tilde input', async () => {
      const homeSshDir = path.join(os.homedir(), '.ssh');
      fs.mkdirSync(homeSshDir, { recursive: true });

      const result = await service.suggestPaths('~/.s', 'directory');

      expect(result.some((item) => item.path === homeSshDir)).toBe(true);
    });

    it('expands the home directory when tilde input uses a backslash', async () => {
      const homeSshDir = path.join(os.homedir(), '.ssh');
      fs.mkdirSync(homeSshDir, { recursive: true });

      const result = await service.suggestPaths('~\\.s', 'directory');

      expect(result.some((item) => item.path === homeSshDir)).toBe(true);
    });

    it('resolves partial parent directories against the deepest existing directory', async () => {
      fs.mkdirSync(path.join(tmpDir, 'projects'));

      const result = await service.suggestPaths(
        path.join(tmpDir, 'pro'),
        'directory',
      );

      expect(result).toEqual([
        expect.objectContaining({
          name: 'projects',
          path: path.join(tmpDir, 'projects'),
          kind: 'directory',
          isExactParent: true,
          trailingSlashHint: true,
        }),
      ]);
    });

    it('returns only directories in directory mode', async () => {
      fs.mkdirSync(path.join(tmpDir, 'repo-one'));
      fs.writeFileSync(path.join(tmpDir, 'repo-one.txt'), 'content');

      const result = await service.suggestPaths(
        path.join(tmpDir, 'repo'),
        'directory',
      );

      expect(result).toEqual([
        expect.objectContaining({
          name: 'repo-one',
          kind: 'directory',
        }),
      ]);
    });

    it('returns files in file-capable mode', async () => {
      fs.mkdirSync(path.join(tmpDir, 'keys'));
      fs.writeFileSync(path.join(tmpDir, 'id_ed25519'), 'secret');

      const result = await service.suggestPaths(
        path.join(tmpDir, 'id_'),
        'either',
      );

      expect(result).toEqual([
        expect.objectContaining({
          name: 'id_ed25519',
          kind: 'file',
          trailingSlashHint: false,
        }),
      ]);
    });

    it('returns an empty list for nonexistent parent directories', async () => {
      const result = await service.suggestPaths(
        '/definitely-not-a-real-path/example',
        'directory',
      );

      expect(result).toEqual([]);
    });

    it('sorts directories before files and then alphabetically', async () => {
      fs.mkdirSync(path.join(tmpDir, 'beta-dir'));
      fs.mkdirSync(path.join(tmpDir, 'alpha-dir'));
      fs.writeFileSync(path.join(tmpDir, 'zeta.txt'), 'zeta');
      fs.writeFileSync(path.join(tmpDir, 'alpha.txt'), 'alpha');

      const result = await service.suggestPaths(
        `${tmpDir}${path.sep}`,
        'either',
      );

      expect(result.map((item) => `${item.kind}:${item.name}`)).toEqual([
        'directory:alpha-dir',
        'directory:beta-dir',
        'file:alpha.txt',
        'file:zeta.txt',
      ]);
    });

    it('treats a trailing forward slash as an exact parent directory', async () => {
      fs.mkdirSync(path.join(tmpDir, 'nested'));

      const result = await service.suggestPaths(
        `${tmpDir.replace(/\\/g, '/')}/`,
        'either',
      );

      expect(result).toEqual([
        expect.objectContaining({
          name: 'nested',
          path: path.join(tmpDir, 'nested'),
          kind: 'directory',
          isExactParent: true,
        }),
      ]);
    });
  });

  describe('searchFiles', () => {
    function initGitRepo(): void {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], {
        cwd: tmpDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'Test User'], {
        cwd: tmpDir,
        stdio: 'ignore',
      });
    }

    it('returns matching tracked and untracked files while excluding ignored and .git paths', async () => {
      initGitRepo();
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored.txt\n');
      fs.writeFileSync(path.join(tmpDir, 'src', 'tracked-file.ts'), 'tracked');
      fs.writeFileSync(path.join(tmpDir, 'src', 'untracked-file.ts'), 'untracked');
      fs.writeFileSync(path.join(tmpDir, 'ignored.txt'), 'ignored');
      execFileSync('git', ['add', '.gitignore', 'src/tracked-file.ts'], {
        cwd: tmpDir,
        stdio: 'ignore',
      });

      const result = await service.searchFiles(tmpDir, 'file');

      expect(result).toEqual([
        { path: 'src/tracked-file.ts', name: 'tracked-file.ts' },
        { path: 'src/untracked-file.ts', name: 'untracked-file.ts' },
      ]);
      expect(result.some((item) => item.path.includes('.git'))).toBe(false);
      expect(result.some((item) => item.path === 'ignored.txt')).toBe(false);
    });

    it('limits and ranks basename prefix matches before basename substring matches', async () => {
      initGitRepo();
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'docs', 'my-search-target.md'), 'docs');
      fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'search-panel.ts'), 'panel');
      fs.writeFileSync(path.join(tmpDir, 'src', 'other-search.ts'), 'other');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });

      const result = await service.searchFiles(tmpDir, 'search', 2);

      expect(result).toEqual([
        {
          path: 'src/components/search-panel.ts',
          name: 'search-panel.ts',
        },
        {
          path: 'docs/my-search-target.md',
          name: 'my-search-target.md',
        },
      ]);
    });

    it('falls back to an async directory walk outside Git repositories', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'plain-file.ts'), 'plain');
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'plain-hidden.ts'), 'hidden');

      const result = await service.searchFiles(tmpDir, 'plain');

      expect(result).toEqual([
        { path: 'src/plain-file.ts', name: 'plain-file.ts' },
      ]);
    });

    it('rejects missing or non-directory worktree paths', async () => {
      await expect(
        service.searchFiles(path.join(tmpDir, 'missing'), 'file'),
      ).rejects.toThrow(BadRequestException);

      const filePath = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      await expect(service.searchFiles(filePath, 'file')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('readFile', () => {
    it('should return content and language for valid file', async () => {
      const filePath = path.join(tmpDir, 'file.ts');
      fs.writeFileSync(filePath, 'file content');

      const result = await service.readFile(filePath, tmpDir);

      expect(result.content).toBe('file content');
      expect(result.language).toBe('typescript');
    });

    it('should throw BadRequestException for path outside worktree', async () => {
      const otherDir = path.join(os.tmpdir(), 'other-' + Date.now());
      fs.mkdirSync(otherDir, { recursive: true });
      const filePath = path.join(otherDir, 'file.ts');
      fs.writeFileSync(filePath, 'content');

      await expect(service.readFile(filePath, tmpDir)).rejects.toThrow(
        BadRequestException,
      );

      fs.rmSync(otherDir, { recursive: true, force: true });
    });

    it('should throw BadRequestException for non-existent file', async () => {
      const filePath = path.join(tmpDir, 'nonexistent.ts');

      await expect(service.readFile(filePath, tmpDir)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should detect correct language for different file types', async () => {
      const pyFile = path.join(tmpDir, 'script.py');
      fs.writeFileSync(pyFile, 'content');
      const pyResult = await service.readFile(pyFile, tmpDir);
      expect(pyResult.language).toBe('python');

      const jsonFile = path.join(tmpDir, 'data.json');
      fs.writeFileSync(jsonFile, 'content');
      const jsonResult = await service.readFile(jsonFile, tmpDir);
      expect(jsonResult.language).toBe('json');

      const mdFile = path.join(tmpDir, 'README.md');
      fs.writeFileSync(mdFile, 'content');
      const mdResult = await service.readFile(mdFile, tmpDir);
      expect(mdResult.language).toBe('markdown');
    });
  });

  describe('writeFile', () => {
    it('should write content to file', async () => {
      const filePath = path.join(tmpDir, 'new-file.ts');

      await service.writeFile(filePath, 'content', tmpDir);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
    });

    it('should create parent directories if needed', async () => {
      const filePath = path.join(tmpDir, 'src', 'components', 'file.ts');

      await service.writeFile(filePath, 'content', tmpDir);

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
    });

    it('should throw BadRequestException for path outside worktree', async () => {
      const otherDir = path.join(os.tmpdir(), 'other-' + Date.now());
      fs.mkdirSync(otherDir, { recursive: true });
      const filePath = path.join(otherDir, 'file.ts');

      await expect(
        service.writeFile(filePath, 'content', tmpDir),
      ).rejects.toThrow(BadRequestException);

      expect(fs.existsSync(filePath)).toBe(false);
      fs.rmSync(otherDir, { recursive: true, force: true });
    });
  });

  describe('createDirectory', () => {
    it('creates nested directories within the worktree', async () => {
      const dirPath = path.join(tmpDir, 'src', 'components', 'nested');

      await service.createDirectory(dirPath, tmpDir);

      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('rejects paths outside the worktree', async () => {
      const otherDir = path.join(os.tmpdir(), 'other-' + Date.now(), 'outside');

      await expect(service.createDirectory(otherDir, tmpDir)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('rename', () => {
    it('moves a file within the worktree', async () => {
      const sourcePath = path.join(tmpDir, 'old-name.ts');
      const destinationPath = path.join(tmpDir, 'new-name.ts');
      fs.writeFileSync(sourcePath, 'content');

      await service.rename(sourcePath, destinationPath, tmpDir);

      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.readFileSync(destinationPath, 'utf-8')).toBe('content');
    });

    it('rejects overwrite=false when destination exists', async () => {
      const sourcePath = path.join(tmpDir, 'source.ts');
      const destinationPath = path.join(tmpDir, 'destination.ts');
      fs.writeFileSync(sourcePath, 'source');
      fs.writeFileSync(destinationPath, 'destination');

      await expect(
        service.rename(sourcePath, destinationPath, tmpDir, false),
      ).rejects.toThrow('Destination already exists');
    });

    it('rejects paths outside the worktree', async () => {
      const sourcePath = path.join(tmpDir, 'source.ts');
      const outsidePath = path.join(
        os.tmpdir(),
        'other-' + Date.now(),
        'target.ts',
      );
      fs.writeFileSync(sourcePath, 'source');

      await expect(
        service.rename(sourcePath, outsidePath, tmpDir),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteEntry', () => {
    it('removes a file', async () => {
      const filePath = path.join(tmpDir, 'file.ts');
      fs.writeFileSync(filePath, 'content');

      await service.deleteEntry(filePath, tmpDir, false);

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('removes a directory only when recursive=true', async () => {
      const dirPath = path.join(tmpDir, 'folder');
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, 'file.ts'), 'content');

      await expect(
        service.deleteEntry(dirPath, tmpDir, false),
      ).rejects.toThrow();
      expect(fs.existsSync(dirPath)).toBe(true);

      await service.deleteEntry(dirPath, tmpDir, true);
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    it('rejects paths outside the worktree', async () => {
      const outsidePath = path.join(
        os.tmpdir(),
        'other-' + Date.now(),
        'file.ts',
      );

      await expect(
        service.deleteEntry(outsidePath, tmpDir, false),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
