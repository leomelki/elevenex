import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import { GitService } from '../git/git.service.js';
import { TextAgentGenerationService } from '../agent-generation/text-agent-generation.service.js';
import { commitSnapshot } from './desktop-commit.js';
import { commitSelection, commitRevision } from './desktop-commit-selection.js';
import { previewCommit } from './desktop-commit-preview.js';

const execute = promisify(execFile);
const selection = { includeUnstaged: true, excluded: [], includedSecrets: [] };
describe('desktop commit snapshot', () => {
  let path: string;
  let service: GitService;
  const git = async (...args: string[]) =>
    (await execute('git', args, { cwd: path, timeout: 10000 })).stdout;
  beforeEach(async () => {
    path = await mkdtemp(join(tmpdir(), 'elevenex-commit-test-'));
    await git('init');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'commit.gpgsign', 'false');
    await writeFile(join(path, 'work.txt'), 'original\n');
    await writeFile(join(path, 'keep.txt'), 'original\n');
    await git('add', '--all');
    await git('commit', '-m', 'Initial');
    const module = await Test.createTestingModule({
      providers: [
        GitService,
        { provide: TextAgentGenerationService, useValue: {} },
      ],
    }).compile();
    service = module.get(GitService);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(path, { recursive: true, force: true });
  });

  it('keeps secrets and excluded staged files out, and freezes before writing a message', async () => {
    await writeFile(join(path, 'work.txt'), 'chosen\n');
    await writeFile(join(path, 'keep.txt'), 'staged but excluded\n');
    await writeFile(join(path, '.env.local'), 'SECRET=value\n');
    await git('add', '--all');
    const status = await service.getStatusSummary(path);
    const phase: string[] = [];
    jest.spyOn(service, 'suggestCommitMessage').mockImplementation(async () => {
      await writeFile(join(path, 'work.txt'), 'later session edit\n');
      return {
        subject: 'fix: save selected changes',
        body: null,
        source: 'ai',
        confidence: 'high',
      };
    });
    await commitSnapshot(
      path,
      service,
      status,
      { ...selection, excluded: ['keep.txt'] },
      '',
      (value) => phase.push(value),
    );
    expect(await git('show', 'HEAD:work.txt')).toBe('chosen\n');
    expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe(
      'later session edit\n',
    );
    expect(await git('show', 'HEAD:keep.txt')).toBe('original\n');
    expect(await git('diff', '--cached', '--name-only')).toContain('keep.txt');
    expect(await git('diff', '--cached', '--name-only')).toContain(
      '.env.local',
    );
    expect(await git('show', '--pretty=', '--name-only', 'HEAD')).toBe(
      'work.txt\n',
    );
    expect(phase).toEqual(['writing', 'committing']);
  });
  it('commits staged content without including later unstaged edits', async () => {
    await writeFile(join(path, 'work.txt'), 'staged\n');
    await git('add', '--', 'work.txt');
    await writeFile(join(path, 'work.txt'), 'unstaged\n');
    await commitSnapshot(
      path,
      service,
      await service.getStatusSummary(path),
      { ...selection, includeUnstaged: false },
      'Save stage',
      () => {},
    );
    expect(await git('show', 'HEAD:work.txt')).toBe('staged\n');
    expect(await readFile(join(path, 'work.txt'), 'utf8')).toBe('unstaged\n');
    expect(await git('diff', '--cached')).toBe('');
  });
  it('rejects index changes during message generation without committing or losing staging', async () => {
    await writeFile(join(path, 'work.txt'), 'chosen\n');
    const before = await git('rev-parse', 'HEAD');
    jest.spyOn(service, 'suggestCommitMessage').mockImplementation(async () => {
      await writeFile(join(path, 'keep.txt'), 'another staged change\n');
      await git('add', '--', 'keep.txt');
      return {
        subject: 'fix: selected',
        body: null,
        source: 'ai',
        confidence: 'high',
      };
    });
    await expect(
      commitSnapshot(
        path,
        service,
        await service.getStatusSummary(path),
        selection,
        '',
        () => {},
      ),
    ).rejects.toThrow();
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    expect(await git('diff', '--cached', '--name-only')).toBe('keep.txt\n');
  });
  it('filters across the complete repository and returns bounded windows with accurate selection', async () => {
    await Promise.all(
      Array.from({ length: 115 }, (_, index) =>
        writeFile(
          join(path, `file-${String(index).padStart(3, '0')}.txt`),
          'new\n',
        ),
      ),
    );
    await writeFile(join(path, '.env.local'), 'secret\n');
    const status = await service.getStatusSummary(path);
    const first = await previewCommit(path, status, selection, '', 0);
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(116);
    expect(first.selected.files).toBe(115);
    expect(first.items[0].flag).toBe('secrets');
    const filtered = await previewCommit(
      path,
      status,
      selection,
      'file-114',
      0,
    );
    expect(filtered.matches).toBe(1);
    expect(filtered.items[0].path).toBe('file-114.txt');
    const staged = await previewCommit(
      path,
      status,
      { ...selection, includeUnstaged: false },
      '',
      0,
    );
    expect(staged.selected.files).toBe(0);
  });
  it('permits ongoing edits to reviewed paths but rejects a changed file set or stage', async () => {
    await writeFile(join(path, 'work.txt'), 'first draft\n');
    const before = await commitRevision(
      path,
      await service.getStatusSummary(path),
    );
    await writeFile(join(path, 'work.txt'), 'ongoing session edit\n');
    expect(
      await commitRevision(path, await service.getStatusSummary(path)),
    ).toBe(before);
    await git('add', '--', 'work.txt');
    expect(
      await commitRevision(path, await service.getStatusSummary(path)),
    ).not.toBe(before);
    await writeFile(join(path, 'new.txt'), 'new file\n');
    expect(
      await commitRevision(path, await service.getStatusSummary(path)),
    ).not.toBe(before);
  });
  it('bounds exception lists and rejects path traversal', () => {
    expect(() =>
      commitSelection({ ...selection, excluded: ['../other'] }),
    ).toThrow();
    expect(() =>
      commitSelection({ ...selection, excluded: Array(1001).fill('file') }),
    ).toThrow();
  });
});
