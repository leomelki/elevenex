import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { RepoContextResolverService } from './repo-context-resolver.service.js';

describe('RepoContextResolverService', () => {
  let service: RepoContextResolverService;
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RepoContextResolverService],
    }).compile();

    service = module.get<RepoContextResolverService>(
      RepoContextResolverService,
    );
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-context-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath);
    execSync('git init', { cwd: repoPath });
    execSync('git config user.email "test@test.com"', { cwd: repoPath });
    execSync('git config user.name "Test User"', { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'hello');
    execSync('git add README.md', { cwd: repoPath });
    execSync('git commit -m "init"', { cwd: repoPath });
    execSync('git branch -M main', { cwd: repoPath });
    execSync('git remote add origin git@github.com:acme/elevenex.git', {
      cwd: repoPath,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses github remotes', () => {
    expect(
      service.parseGitHubRemote('git@github.com:acme/elevenex.git'),
    ).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'elevenex',
    });
    expect(
      service.parseGitHubRemote('https://github.com/acme/elevenex.git'),
    ).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'elevenex',
    });
  });

  it('resolves branch context without upstream', async () => {
    const context = await service.resolve(repoPath);
    expect(context.branch).toBe('main');
    expect(context.upstream).toBeNull();
    expect(context.remoteName).toBe('origin');
    expect(context.owner).toBe('acme');
    expect(context.repo).toBe('elevenex');
  });

  it('coalesces concurrent normalized paths without retaining stale branch or HEAD state', async () => {
    const first = service.resolve(repoPath);
    const concurrent = service.resolve(`${repoPath}/./`);
    expect(concurrent).toBe(first);
    const original = await first;

    execSync('git switch -c next', { cwd: repoPath });
    execSync('git commit --allow-empty -m next', { cwd: repoPath });
    const next = await service.resolve(repoPath);
    expect(next.branch).toBe('next');
    expect(next.headSha).not.toBe(original.headSha);
  });

  it('retries after a failed context read and rejects detached HEAD', async () => {
    await expect(
      service.resolve(path.join(repoPath, 'missing')),
    ).rejects.toThrow();
    fs.mkdirSync(path.join(repoPath, 'missing'));
    expect((await service.resolve(path.join(repoPath, 'missing'))).branch).toBe(
      'main',
    );

    execSync('git checkout --detach', { cwd: repoPath });
    await expect(service.resolve(repoPath)).rejects.toThrow('Detached HEAD');
  });
});
