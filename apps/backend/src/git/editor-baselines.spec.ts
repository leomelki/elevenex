import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EditorBaselines } from './editor-baselines';
import { GitService } from './git.service';

const exec = promisify(execFile);
describe('editor Git snapshots', () => {
  let root: string;
  const git = (...args: string[]) => exec('git', args, { cwd: root });
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'editor-baseline-'));
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'user.name', 'Test');
    await writeFile(path.join(root, 'original.ts'), 'original');
    await git('add', '.');
    await git('commit', '-qm', 'initial');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  it('caches by immutable SHA and observes HEAD/ref changes without enumerating branches', async () => {
    const baselines = new EditorBaselines();
    const run = jest.spyOn(baselines as any, 'git');
    expect(await baselines.read(root, 'HEAD', 'original.ts')).toBe('original');
    expect(await baselines.read(root, 'main', 'original.ts')).toBe('original');
    expect(
      run.mock.calls.filter(([, args]: any) => args[0] === 'show'),
    ).toHaveLength(1);
    await writeFile(path.join(root, 'original.ts'), 'next');
    await git('add', '.');
    await git('commit', '-qm', 'next');
    expect(await baselines.read(root, 'HEAD', 'original.ts')).toBe('next');
    expect(
      run.mock.calls.filter(([, args]: any) => args[0] === 'show'),
    ).toHaveLength(2);
    expect(
      run.mock.calls.every(
        ([, args]: any) => !args.includes('branch') && !args.includes('log'),
      ),
    ).toBe(true);
  });
  it('cancels a shared subprocess only after its last reader leaves', async () => {
    const baselines = new EditorBaselines();
    let signal!: AbortSignal;
    jest
      .spyOn(baselines as any, 'git')
      .mockImplementation((_root: any, _args: any, abort: any) => {
        signal = abort;
        return new Promise<string>((_resolve, reject) =>
          abort.addEventListener('abort', () => reject(abort.reason)),
        );
      });
    const first = new AbortController(),
      second = new AbortController();
    const one = baselines.read(
      root,
      'a'.repeat(40),
      'original.ts',
      first.signal,
    );
    const two = baselines.read(
      root,
      'a'.repeat(40),
      'original.ts',
      second.signal,
    );
    const rejectedOne = expect(one).rejects.toThrow();
    first.abort();
    await rejectedOne;
    expect(signal.aborted).toBe(false);
    const rejectedTwo = expect(two).rejects.toThrow();
    second.abort();
    await rejectedTwo;
    expect(signal.aborted).toBe(true);
  });
  it('preserves staged, unstaged, renamed and nested untracked status coverage', async () => {
    await rename(path.join(root, 'original.ts'), path.join(root, 'renamed.ts'));
    await git('add', '.');
    await writeFile(path.join(root, 'renamed.ts'), 'edited after staging');
    await mkdir(path.join(root, 'new'));
    await writeFile(path.join(root, 'new', 'nested.ts'), 'untracked');
    const service = new GitService({} as any);
    const result = await service.getEditorStatus(root);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: 'renamed.ts',
          oldPath: 'original.ts',
          status: 'renamed',
          staged: true,
        },
        {
          path: 'renamed.ts',
          oldPath: 'original.ts',
          status: 'modified',
          staged: false,
        },
        { path: 'new/nested.ts', status: 'untracked', staged: false },
      ]),
    );
  });
});
