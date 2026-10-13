import { NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ReviewPreviewService,
  type PreviewAsset,
} from './review-preview.service.js';

function bodyText(body: PreviewAsset['body']): string {
  if (!Buffer.isBuffer(body)) throw new Error('Expected a buffered test asset');
  return body.toString('utf-8');
}

describe('ReviewPreviewService', () => {
  let service: ReviewPreviewService;
  let root: string;
  let outside: string;
  let previewId: string;

  beforeEach(async () => {
    service = new ReviewPreviewService();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'review-preview-'));
    await fs.mkdir(path.join(base, 'worktree', 'docs'), { recursive: true });
    // realpath so the assertions below compare like with like: macOS puts
    // temp dirs behind a /var -> /private/var symlink.
    root = await fs.realpath(path.join(base, 'worktree'));
    outside = await fs.realpath(base);

    await fs.writeFile(path.join(root, 'docs', 'index.html'), '<p>hi</p>');
    await fs.writeFile(
      path.join(root, 'docs', 'style.css'),
      'p { color: red }',
    );
    await fs.writeFile(path.join(outside, 'secret.txt'), 'do not read me');

    const session = await service.createSession(root, 'http://localhost:4200');
    previewId = session.previewId;
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await fs.rm(outside, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const read = (assetPath: string) => service.readAsset(previewId, assetPath);

  it('serves a file inside the worktree', async () => {
    const asset = await read('docs/style.css');
    expect(asset.mimeType).toContain('text/css');
    expect(bodyText(asset.body)).toContain('color: red');
  });

  it('accepts the array of segments Express gives for a wildcard path', async () => {
    // This is the shape the controller actually receives for a nested asset;
    // treating it as a string silently 404s every dependency a page has.
    const asset = await service.readAsset(previewId, ['docs', 'style.css']);
    expect(bodyText(asset.body)).toContain('color: red');
  });

  it('serves the root index for the bare prefix', async () => {
    await fs.writeFile(path.join(root, 'index.html'), '<p>root</p>');
    const asset = await service.readAsset(previewId, []);
    expect(bodyText(asset.body)).toContain('root');
  });

  it('rejects a doubly-encoded traversal without decoding it again', async () => {
    // Express has already decoded once; decoding here would turn this into a
    // real '..' segment.
    await expect(read('%2e%2e/secret.txt')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('instruments html and attaches a policy', async () => {
    const asset = await read('docs/index.html');
    expect(asset.instrumented).toBe(true);
    expect(bodyText(asset.body)).toContain('data-ex-line');
    expect(asset.contentSecurityPolicy).toContain(
      'connect-src http://localhost:4200/api/review-preview/p/',
    );
    expect(asset.contentSecurityPolicy).toContain("default-src 'none'");
    expect(asset.contentSecurityPolicy).toContain('sandbox allow-scripts');
  });

  it('confines connect-src when the browser origin is unknown', async () => {
    const blind = new ReviewPreviewService();
    blind.onModuleDestroy();
    const session = await blind.createSession(root, null);
    const asset = await blind.readAsset(session.previewId, 'docs/index.html');

    expect(asset.contentSecurityPolicy).toContain("connect-src 'none'");
  });

  it('ends the policy prefix with a slash, so CSP matches by prefix', async () => {
    const asset = await read('docs/index.html');
    expect(asset.contentSecurityPolicy).toMatch(
      /connect-src http:\/\/localhost:4200\/api\/review-preview\/p\/[0-9a-f]+\//,
    );
  });

  it('rejects traversal out of the worktree', async () => {
    await expect(read('../secret.txt')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(read('docs/../../secret.txt')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a symlink pointing outside the worktree', async () => {
    // The lexical containment check passes for this path; only resolving the
    // real path catches it.
    await fs.symlink(
      path.join(outside, 'secret.txt'),
      path.join(root, 'leak.txt'),
    );
    await expect(read('leak.txt')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects paths into .git', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), 'x');
    await expect(read('.git/config')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects the reserved bridge segment as an asset path', async () => {
    await expect(read('___ex/bridge.js')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('serves index.html for a directory', async () => {
    const asset = await read('docs');
    expect(bodyText(asset.body)).toContain('hi');
  });

  it('rejects an unknown preview id', async () => {
    await expect(
      service.readAsset('deadbeef', 'docs/index.html'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reuses the session for the same worktree', async () => {
    const again = await service.createSession(root, 'http://localhost:4200');
    expect(again.previewId).toBe(previewId);
  });

  it('adopts a new browser origin when a session is reopened', async () => {
    await service.createSession(root, 'http://127.0.0.1:11111');
    const asset = await read('docs/index.html');
    expect(asset.contentSecurityPolicy).toContain('http://127.0.0.1:11111');
  });

  it('ignores a malformed declared origin', async () => {
    const blind = new ReviewPreviewService();
    blind.onModuleDestroy();
    const session = await blind.createSession(root, 'javascript:alert(1)');
    const asset = await blind.readAsset(session.previewId, 'docs/index.html');

    expect(asset.contentSecurityPolicy).toContain("connect-src 'none'");
  });

  it('isolates visualization library allowances from review sessions', async () => {
    const visualization = await service.createSession(
      root,
      'http://localhost:4200',
      true,
    );
    expect(visualization.previewId).not.toBe(previewId);
    expect(
      (await service.createSession(root, 'http://localhost:4200', true))
        .previewId,
    ).toBe(visualization.previewId);
    const asset = await service.readAsset(
      visualization.previewId,
      'docs/index.html',
    );
    expect(bodyText(asset.body)).toContain('data-ex-visualization="1"');
    expect(asset.contentSecurityPolicy).toContain('https://cdn.jsdelivr.net');
    expect(asset.contentSecurityPolicy).toContain('sandbox allow-scripts');
    const connect = asset
      .contentSecurityPolicy!.split('; ')
      .find((rule) => rule.startsWith('connect-src'));
    expect(connect).toBe(
      `connect-src http://localhost:4200/api/review-preview/p/${visualization.previewId}/`,
    );
    expect((await read('docs/index.html')).contentSecurityPolicy).not.toContain(
      'cdn.jsdelivr.net',
    );
    await expect(
      service.readAsset(visualization.previewId, '../secret.txt'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps live visualization and review URLs valid beyond 32 artifact directories', async () => {
    const directories = Array.from({ length: 64 }, (_, index) =>
      path.join(root, `chart-${index}`),
    );
    await Promise.all(directories.map((directory) => fs.mkdir(directory)));
    const sessions = [];
    for (const directory of directories) {
      sessions.push(
        await service.createSession(directory, 'http://localhost:4200', true),
      );
    }
    expect(bodyText((await read('docs/index.html')).body)).toContain('hi');
    for (const session of sessions) {
      expect(service.requireSession(session.previewId).visualization).toBe(
        true,
      );
    }
    expect(
      (
        await service.createSession(
          directories[0],
          'http://localhost:4200',
          true,
        )
      ).previewId,
    ).toBe(sessions[0].previewId);
  });

  it('extends active capabilities with a batched heartbeat and reports expired IDs', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const session = await service.createSession(root, null, true);
    now.mockReturnValue(5 * 60 * 60 * 1000);
    expect(
      service.touchSessions([session.previewId, session.previewId]),
    ).toEqual({ expired: [] });
    now.mockReturnValue(10 * 60 * 60 * 1000);
    expect(service.requireSession(session.previewId).previewId).toBe(
      session.previewId,
    );
    now.mockReturnValue(17 * 60 * 60 * 1000);
    expect(service.touchSessions([session.previewId])).toEqual({
      expired: [session.previewId],
    });
    const renewed = await service.createSession(root, null, true);
    expect(renewed.previewId).not.toBe(session.previewId);
    expect(
      service.touchSessions([session.previewId, renewed.previewId]),
    ).toEqual({ expired: [session.previewId] });
  });

  it('rejects malformed or oversized heartbeat batches', () => {
    for (const ids of [null, {}, ['unknown'], Array(1025).fill(previewId)]) {
      expect(() => service.touchSessions(ids)).toThrow('previewIds');
    }
  });
});
