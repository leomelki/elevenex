import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
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
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readLocalMedia', () => {
    it('streams media outside a repository with byte-range support', async () => {
      const file = path.join(tmpDir, 'outside.mp4');
      await fs.promises.writeFile(file, '0123456789');
      const result = await service.readLocalMedia(file, 'bytes=2-5');
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('2345');
      expect(result).toMatchObject({
        statusCode: 206,
        contentRange: 'bytes 2-5/10',
        mimeType: 'video/mp4',
      });
    });

    it('supports home-relative media', async () => {
      const raw = jest
        .spyOn(service, 'readFileRaw')
        .mockResolvedValue({
          stream: require('node:stream').Readable.from([]),
          mimeType: 'image/png',
          length: 0,
          statusCode: 200,
        });
      await service.readLocalMedia('~/Pictures/shot.png');
      expect(raw).toHaveBeenCalledWith(
        path.join(os.homedir(), 'Pictures/shot.png'),
        path.join(os.homedir(), 'Pictures'),
        undefined,
      );
    });

    it('rejects relative paths and non-media files', async () => {
      await expect(service.readLocalMedia('relative.png')).rejects.toThrow(
        'absolute',
      );
      await expect(
        service.readLocalMedia(path.join(tmpDir, 'notes.txt')),
      ).rejects.toThrow('image or video');
    });
  });

  describe('readFileRaw', () => {
    async function read(range?: string) {
      const file = path.join(tmpDir, 'demo.mp4');
      await fs.promises.writeFile(file, '0123456789');
      const result = await service.readFileRaw(file, tmpDir, range);
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
      return { ...result, body: Buffer.concat(chunks).toString() };
    }

    it('streams the complete file without buffering it in the service', async () => {
      expect(await read()).toMatchObject({
        body: '0123456789',
        length: 10,
        mimeType: 'video/mp4',
        statusCode: 200,
      });
    });

    it.each([
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=8-100', '89', 'bytes 8-9/10'],
      ['bytes=-100', '0123456789', 'bytes 0-9/10'],
    ])(
      'streams the requested range %s for video seeking',
      async (range, body, contentRange) => {
        expect(await read(range)).toMatchObject({
          body,
          length: body.length,
          contentRange,
          statusCode: 206,
        });
      },
    );

    it.each([
      'bytes=10-',
      'bytes=5-2',
      'bytes=-0',
      'bytes=-',
      'bad',
      'bytes=0-1,4-5',
    ])('rejects invalid or unsatisfiable ranges: %s', async (range) => {
      expect(await read(range)).toMatchObject({
        body: '',
        length: 0,
        statusCode: 416,
        contentRange: 'bytes */10',
      });
    });

    it('rejects files outside the worktree and missing files before streaming', async () => {
      await expect(
        service.readFileRaw(path.join(tmpDir, '../outside.mp4'), tmpDir),
      ).rejects.toThrow('Access denied');
      await expect(
        service.readFileRaw(path.join(tmpDir, 'missing.mp4'), tmpDir),
      ).rejects.toThrow('File does not exist');
    });
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
    it('rejects traversal before accessing a directory outside the worktree', async () => {
      const stat = jest.spyOn(fs.promises, 'stat');
      const readdir = jest.spyOn(fs.promises, 'readdir');
      await expect(service.listFiles(tmpDir, '../')).rejects.toThrow(
        'outside worktree',
      );
      expect(stat).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
    });

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

    it('includes dotfiles and dot directories while excluding Git internals', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'content');
      fs.mkdirSync(path.join(tmpDir, '.hidden'));
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, '.hidden', '.config.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'content');

      const result = await service.listFiles(tmpDir);

      expect(result.map((node) => node.label)).toEqual([
        '.hidden',
        '.gitignore',
        'visible.txt',
      ]);
      const nested = await service.listFiles(tmpDir, '.hidden');
      expect(nested[0].data.path).toBe('.hidden/.config.json');
      await expect(
        service.readFile(path.join(tmpDir, '.hidden', '.config.json'), tmpDir),
      ).resolves.toMatchObject({ content: '{}' });
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
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'untracked-file.ts'),
        'untracked',
      );
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
      fs.writeFileSync(
        path.join(tmpDir, 'docs', 'my-search-target.md'),
        'docs',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'components', 'search-panel.ts'),
        'panel',
      );
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
      fs.writeFileSync(
        path.join(tmpDir, '.hidden', 'plain-hidden.ts'),
        'hidden',
      );

      const result = await service.searchFiles(tmpDir, 'plain');

      expect(result).toEqual(
        expect.arrayContaining([
          { path: 'src/plain-file.ts', name: 'plain-file.ts' },
          { path: '.hidden/plain-hidden.ts', name: 'plain-hidden.ts' },
        ]),
      );
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

  describe('searchText', () => {
    it('maps thousands of matches on a large Unicode line without repeatedly encoding it', async () => {
      const prefix = 'é😀'.repeat(200_000);
      const suffix = 'é😀needle'.repeat(1_500);
      const line = prefix + suffix;
      await fs.promises.writeFile(path.join(tmpDir, 'bundle.js'), `${line}\n`);
      const encode = jest.spyOn(Buffer, 'from');
      const [result] = await service.searchText(tmpDir, { query: 'needle' });
      const encodedWholeLines = encode.mock.calls.filter(
        ([value]) => typeof value === 'string' && value === line,
      );
      expect(encodedWholeLines).toHaveLength(1);
      expect(result.ranges).toHaveLength(1_500);
      expect(result.ranges[0]).toEqual({
        start: prefix.length + 3,
        end: prefix.length + 9,
      });
      expect(result.ranges[1_499]).toEqual({
        start: prefix.length + 1_499 * 9 + 3,
        end: line.length,
      });
      expect(result.lineText.length).toBeLessThanOrEqual(1_000);
      const range = result.previewRanges![0];
      expect(result.lineText.slice(range.start, range.end)).toBe('needle');
    });

    it('caps matches on one minified line and reports limitHit with correct retained offsets', async () => {
      await fs.promises.writeFile(
        path.join(tmpDir, 'bundle.js'),
        'é😀needle'.repeat(10_000),
      );
      const results: import('./files.service.js').TextSearchResult[] = [];
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle' },
        (batch) => results.push(...batch),
      );
      expect(summary.limitHit).toBe(true);
      expect(results[0].ranges).toHaveLength(2_000);
      expect(results[0].ranges[1_999]).toEqual({
        start: 1_999 * 9 + 3,
        end: 2_000 * 9,
      });
    });

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

    it('returns literal matches with path, line number, ranges, and preview text', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'app.ts'),
        ['const alpha = 1;', 'const needle = alpha;', ''].join('\n'),
      );

      const result = await service.searchText(tmpDir, {
        query: 'needle',
        isRegExp: false,
      });

      expect(result).toEqual([
        {
          path: 'src/app.ts',
          lineNumber: 1,
          lineText: 'const needle = alpha;',
          ranges: [{ start: 6, end: 12 }],
        },
      ]);
    });

    it('supports regular expressions', async () => {
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'search_123\nsearch_abc\n');

      const result = await service.searchText(tmpDir, {
        query: 'search_\\d+',
        isRegExp: true,
      });

      expect(result.map((item) => item.lineText)).toEqual(['search_123']);
    });

    it('honors case sensitivity and whole-word matching', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'app.ts'),
        'Needle\nneedle\nneedles\n',
      );

      const caseSensitive = await service.searchText(tmpDir, {
        query: 'needle',
        isCaseSensitive: true,
      });
      const wholeWord = await service.searchText(tmpDir, {
        query: 'needle',
        isCaseSensitive: false,
        isWordMatch: true,
      });

      expect(caseSensitive.map((item) => item.lineText)).toEqual([
        'needle',
        'needles',
      ]);
      expect(wholeWord.map((item) => item.lineText)).toEqual([
        'Needle',
        'needle',
      ]);
    });

    it('respects include and exclude globs', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'needle\n');
      fs.writeFileSync(path.join(tmpDir, 'src', 'skip.spec.ts'), 'needle\n');
      fs.writeFileSync(path.join(tmpDir, 'docs', 'guide.md'), 'needle\n');

      const result = await service.searchText(tmpDir, {
        query: 'needle',
        includes: ['src/**'],
        excludes: ['**/*.spec.ts'],
      });

      expect(result.map((item) => item.path)).toEqual(['src/app.ts']);
    });

    it('respects ignore files and excludes .git content by default', async () => {
      initGitRepo();
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'ignored.txt\n');
      fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'needle\n');
      fs.writeFileSync(path.join(tmpDir, 'ignored.txt'), 'needle\n');
      fs.writeFileSync(path.join(tmpDir, '.git', 'hidden.txt'), 'needle\n');
      execFileSync('git', ['add', '.gitignore', 'visible.txt'], {
        cwd: tmpDir,
        stdio: 'ignore',
      });

      const result = await service.searchText(tmpDir, { query: 'needle' });

      expect(result.map((item) => item.path)).toEqual(['visible.txt']);
    });

    it('limits results globally', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'needle\nneedle\n');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'needle\nneedle\n');

      const result = await service.searchText(tmpDir, {
        query: 'needle',
        maxResults: 2,
      });

      expect(result).toHaveLength(2);
    });

    it('rejects missing or non-directory worktree paths', async () => {
      await expect(
        service.searchText(path.join(tmpDir, 'missing'), { query: 'needle' }),
      ).rejects.toThrow(BadRequestException);

      const filePath = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(filePath, 'needle');

      await expect(
        service.searchText(filePath, { query: 'needle' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('windows the preview of very long lines while keeping document ranges', async () => {
      const prefix = 'x'.repeat(4_000);
      fs.writeFileSync(
        path.join(tmpDir, 'bundle.js'),
        `${prefix}needle${'y'.repeat(4_000)}\n`,
      );

      const [result] = await service.searchText(tmpDir, { query: 'needle' });

      expect(result.previewTruncated).toBe(true);
      expect(result.lineText.length).toBeLessThanOrEqual(1_000);
      // Document coordinates still point at the real match.
      expect(result.ranges).toEqual([{ start: 4_000, end: 4_006 }]);
      // Preview coordinates index into the returned snippet.
      const previewRange = result.previewRanges![0];
      expect(result.lineText.slice(previewRange.start, previewRange.end)).toBe(
        'needle',
      );
    });

    it('leaves short previews untouched', async () => {
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'const needle = 1;\n');

      const [result] = await service.searchText(tmpDir, { query: 'needle' });

      expect(result.previewTruncated).toBeUndefined();
      expect(result.previewRanges).toBeUndefined();
      expect(result.lineText).toBe('const needle = 1;');
    });
  });

  describe('searchTextStream', () => {
    function mockRipgrep(chunks: Buffer[], trailingNewline = true): jest.Mock {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: jest.Mock;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      jest
        .spyOn(require('node:child_process'), 'spawn')
        .mockImplementationOnce(() => {
          // Queue after the service has attached its stdout and close listeners.
          setImmediate(() => {
            for (const chunk of chunks) child.stdout.emit('data', chunk);
            if (trailingNewline) child.stdout.emit('data', Buffer.from('\n'));
            child.emit('close', 0, null);
          });
          return child;
        });
      return child.kill;
    }

    it.each([true, false])(
      'decodes split multibyte stdout with trailing newline=%s',
      async (trailingNewline) => {
        const line = 'é😀needle漢needle';
        const event = JSON.stringify({
          type: 'match',
          data: {
            path: { text: './été😀.ts' },
            lines: { text: `${line}\r\n` },
            line_number: 2,
            submatches: [
              { start: 6, end: 12 },
              { start: 15, end: 21 },
            ],
          },
        });
        // One byte per chunk splits every non-ASCII character in both fields.
        mockRipgrep(
          [...Buffer.from(event)].map((byte) => Buffer.from([byte])),
          trailingNewline,
        );
        expect(await service.searchText(tmpDir, { query: 'needle' })).toEqual([
          {
            path: 'été😀.ts',
            lineNumber: 1,
            lineText: line,
            ranges: [
              { start: 3, end: 9 },
              { start: 10, end: 16 },
            ],
          },
        ]);
      },
    );

    it('bounds an oversized JSON record spread across many stdout chunks', async () => {
      const kill = mockRipgrep(
        Array.from({ length: 150 }, () => Buffer.alloc(64 * 1024, 120)),
      );
      const batch = jest.fn();
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle' },
        batch,
      );
      expect(summary.limitHit).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(batch).not.toHaveBeenCalled();
    });

    it('delivers matches through the callback and reports limitHit', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'a.txt'),
        Array.from({ length: 20 }, () => 'needle').join('\n'),
      );

      const batches: unknown[][] = [];
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle', maxResults: 5 },
        (batch) => batches.push(batch),
      );

      expect(summary).toEqual({ limitHit: true });
      expect(batches.length).toBeGreaterThan(0);
      expect(batches.flat()).toHaveLength(5);
    });

    it('does not report limitHit when the search completes under the limit', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'needle\nneedle\n');

      const batches: unknown[][] = [];
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle', maxResults: 50 },
        (batch) => batches.push(batch),
      );

      expect(summary).toEqual({ limitHit: false });
      expect(batches.flat()).toHaveLength(2);
    });

    it('stops without emitting when the signal is already aborted', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'needle\n');
      const controller = new AbortController();
      controller.abort();

      const batches: unknown[][] = [];
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle' },
        (batch) => batches.push(batch),
        controller.signal,
      );

      expect(summary).toEqual({ limitHit: false });
      expect(batches).toHaveLength(0);
    });

    it('resolves early when the signal aborts mid-search', async () => {
      for (let index = 0; index < 40; index += 1) {
        fs.writeFileSync(
          path.join(tmpDir, `file-${index}.txt`),
          Array.from({ length: 200 }, () => 'needle').join('\n'),
        );
      }

      const controller = new AbortController();
      const summary = await service.searchTextStream(
        tmpDir,
        { query: 'needle', maxResults: 2_000 },
        () => controller.abort(),
        controller.signal,
      );

      expect(summary.limitHit).toBe(false);
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

  describe('writeFileStream', () => {
    it('preserves binary bytes and creates parent directories', async () => {
      const file = path.join(tmpDir, 'nested', 'trace.json.gz');
      const bytes = Buffer.from([0x1f, 0x8b, 0, 0xff, 0x80]);
      await service.writeFileStream(file, Readable.from([bytes]), tmpDir);
      expect(await fs.promises.readFile(file)).toEqual(bytes);
      expect(await fs.promises.readdir(path.dirname(file))).toEqual([
        'trace.json.gz',
      ]);
    });

    it('writes an empty file and preserves existing executable permissions', async () => {
      const file = path.join(tmpDir, 'script.sh');
      await fs.promises.writeFile(file, 'original', { mode: 0o755 });
      await service.writeFileStream(file, Readable.from([]), tmpDir);
      expect((await fs.promises.stat(file)).mode & 0o777).toBe(0o755);
      expect(await fs.promises.readFile(file)).toHaveLength(0);
    });

    it('cleans up an interrupted upload and preserves the original file', async () => {
      const file = path.join(tmpDir, 'trace.gz');
      await fs.promises.writeFile(file, 'original');
      const content = Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('upload disconnected');
        })(),
      );
      await expect(
        service.writeFileStream(file, content, tmpDir),
      ).rejects.toThrow('upload disconnected');
      expect(await fs.promises.readFile(file, 'utf8')).toBe('original');
      expect(await fs.promises.readdir(tmpDir)).toEqual(['trace.gz']);
    });

    it('discards uploads when the task becomes inactive before commit', async () => {
      const file = path.join(tmpDir, 'trace.gz');
      await fs.promises.writeFile(file, 'original');
      await expect(
        service.writeFileStream(
          file,
          Readable.from(['replacement']),
          tmpDir,
          async () => {
            throw new Error('inactive task');
          },
        ),
      ).rejects.toThrow('inactive task');
      expect(await fs.promises.readFile(file, 'utf8')).toBe('original');
      expect(await fs.promises.readdir(tmpDir)).toEqual(['trace.gz']);
    });

    it('rejects paths outside the worktree', async () => {
      await expect(
        service.writeFileStream(
          path.join(tmpDir, '../outside.gz'),
          Readable.from([]),
          tmpDir,
        ),
      ).rejects.toThrow('outside worktree');
    });

    it('preserves symlinks when overwriting a file inside the worktree', async () => {
      const target = path.join(tmpDir, 'target.txt');
      const link = path.join(tmpDir, 'link.txt');
      await fs.promises.writeFile(target, 'original');
      await fs.promises.symlink(target, link);
      await service.writeFileStream(
        link,
        Readable.from(['replacement']),
        tmpDir,
      );
      expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.promises.readFile(target, 'utf8')).toBe('replacement');
    });

    it('rejects symlinks pointing outside the worktree', async () => {
      const root = path.join(tmpDir, 'checkout');
      await fs.promises.mkdir(root);
      const target = path.join(tmpDir, 'outside.txt');
      await fs.promises.writeFile(target, 'original');
      const link = path.join(root, 'link.txt');
      await fs.promises.symlink(target, link);
      await expect(
        service.writeFileStream(link, Readable.from(['replacement']), root),
      ).rejects.toThrow('outside worktree');
      expect(await fs.promises.readFile(target, 'utf8')).toBe('original');
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
    it.each([false, true])(
      'keeps the source for an identical normalized path (overwrite=%s)',
      async (overwrite) => {
        const source = path.join(tmpDir, 'same.txt');
        await fs.promises.writeFile(source, 'source');
        await service.rename(
          source,
          `${tmpDir}/sub/../same.txt`,
          tmpDir,
          overwrite,
        );
        expect(await fs.promises.readFile(source, 'utf8')).toBe('source');
      },
    );

    it('keeps both hard links when the destination has the same identity', async () => {
      const source = path.join(tmpDir, 'source');
      const target = path.join(tmpDir, 'target');
      await fs.promises.writeFile(source, 'source');
      await fs.promises.link(source, target);
      await service.rename(source, target, tmpDir, true);
      expect(await fs.promises.readFile(source, 'utf8')).toBe('source');
      expect(await fs.promises.readFile(target, 'utf8')).toBe('source');
    });

    it('rejects ancestor overwrites and moves into descendants before removing anything', async () => {
      const parent = path.join(tmpDir, 'parent');
      const child = path.join(parent, 'child');
      await fs.promises.mkdir(child, { recursive: true });
      await fs.promises.writeFile(path.join(child, 'data'), 'source');
      await expect(service.rename(child, parent, tmpDir, true)).rejects.toThrow(
        'ancestor',
      );
      await expect(
        service.rename(parent, path.join(child, 'nested'), tmpDir, true),
      ).rejects.toThrow('ancestor');
      expect(await fs.promises.readFile(path.join(child, 'data'), 'utf8')).toBe(
        'source',
      );
    });

    it('rejects ancestor aliases through symlinked parents', async () => {
      const parent = path.join(tmpDir, 'parent');
      const child = path.join(parent, 'child');
      await fs.promises.mkdir(child, { recursive: true });
      await fs.promises.symlink(parent, path.join(tmpDir, 'alias'));
      await fs.promises.writeFile(path.join(child, 'data'), 'source');
      await expect(
        service.rename(
          path.join(tmpDir, 'alias', 'child'),
          parent,
          tmpDir,
          true,
        ),
      ).rejects.toThrow('ancestor');
      expect(await fs.promises.readFile(path.join(child, 'data'), 'utf8')).toBe(
        'source',
      );
    });

    it('rejects paths through parents outside the checkout before replacing either entry', async () => {
      const root = path.join(tmpDir, 'checkout');
      const outside = path.join(tmpDir, 'outside');
      await fs.promises.mkdir(root);
      await fs.promises.mkdir(outside);
      const source = path.join(root, 'source');
      await fs.promises.writeFile(source, 'source');
      await fs.promises.writeFile(path.join(outside, 'target'), 'destination');
      await fs.promises.symlink(outside, path.join(root, 'alias'));
      await expect(
        service.rename(source, path.join(root, 'alias', 'target'), root, true),
      ).rejects.toThrow('outside worktree');
      expect(await fs.promises.readFile(source, 'utf8')).toBe('source');
      expect(
        await fs.promises.readFile(path.join(outside, 'target'), 'utf8'),
      ).toBe('destination');
    });

    it('rejects replacing or moving the checkout root', async () => {
      const source = path.join(tmpDir, 'source');
      await fs.promises.writeFile(source, 'source');
      await expect(
        service.rename(source, tmpDir, tmpDir, true),
      ).rejects.toThrow('worktree root');
      await expect(
        service.rename(tmpDir, path.join(tmpDir, 'target'), tmpDir, true),
      ).rejects.toThrow('worktree root');
      expect(await fs.promises.readFile(source, 'utf8')).toBe('source');
    });

    it('preserves the destination when the source is missing or rename fails', async () => {
      const source = path.join(tmpDir, 'source');
      const target = path.join(tmpDir, 'target');
      await fs.promises.writeFile(target, 'destination');
      await expect(
        service.rename(source, target, tmpDir, true),
      ).rejects.toThrow('does not exist');
      await fs.promises.writeFile(source, 'source');
      jest
        .spyOn(fs.promises, 'rename')
        .mockRejectedValueOnce(
          Object.assign(new Error('permission'), { code: 'EACCES' }),
        );
      await expect(
        service.rename(source, target, tmpDir, true),
      ).rejects.toThrow('permission');
      expect(await fs.promises.readFile(source, 'utf8')).toBe('source');
      expect(await fs.promises.readFile(target, 'utf8')).toBe('destination');
    });

    it('overwrites non-empty directories and removes only the old destination contents', async () => {
      const source = path.join(tmpDir, 'source');
      const target = path.join(tmpDir, 'target');
      await fs.promises.mkdir(source);
      await fs.promises.mkdir(target);
      await fs.promises.writeFile(path.join(source, 'new'), 'new');
      await fs.promises.writeFile(path.join(target, 'old'), 'old');
      await service.rename(source, target, tmpDir, true);
      expect(await fs.promises.readdir(target)).toEqual(['new']);
      expect(await fs.promises.readdir(tmpDir)).toEqual(['target']);
    });

    it('restores a non-empty destination if moving the source fails after staging', async () => {
      const source = path.join(tmpDir, 'source');
      const target = path.join(tmpDir, 'target');
      await fs.promises.mkdir(source);
      await fs.promises.mkdir(target);
      await fs.promises.writeFile(path.join(source, 'new'), 'new');
      await fs.promises.writeFile(path.join(target, 'old'), 'old');
      const rename = fs.promises.rename;
      let calls = 0;
      jest
        .spyOn(fs.promises, 'rename')
        .mockImplementation(async (old, next) => {
          calls += 1;
          if (calls === 3) throw new Error('source move failed');
          return rename(old, next);
        });
      await expect(
        service.rename(source, target, tmpDir, true),
      ).rejects.toThrow('source move failed');
      expect(await fs.promises.readFile(path.join(source, 'new'), 'utf8')).toBe(
        'new',
      );
      expect(await fs.promises.readFile(path.join(target, 'old'), 'utf8')).toBe(
        'old',
      );
      expect((await fs.promises.readdir(tmpDir)).sort()).toEqual([
        'source',
        'target',
      ]);
    });

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
