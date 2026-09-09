import { NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReviewPreviewService } from './review-preview.service.js';

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
    await fs.writeFile(path.join(root, 'docs', 'style.css'), 'p { color: red }');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'do not read me');

    const session = await service.createSession(root, 'http://localhost:4200');
    previewId = session.previewId;
  });

  const read = (assetPath: string) => service.readAsset(previewId, assetPath);

  it('serves a file inside the worktree', async () => {
    const asset = await read('docs/style.css');
    expect(asset.mimeType).toContain('text/css');
    expect(asset.body.toString()).toContain('color: red');
  });

  it('instruments html and attaches a policy', async () => {
    const asset = await read('docs/index.html');
    expect(asset.instrumented).toBe(true);
    expect(asset.body.toString()).toContain('data-ex-line');
    expect(asset.contentSecurityPolicy).toContain(
      "connect-src http://localhost:4200/api/review-preview/p/",
    );
    expect(asset.contentSecurityPolicy).toContain("default-src 'none'");
    expect(asset.contentSecurityPolicy).toContain('sandbox allow-scripts');
  });

  it('confines connect-src when the browser origin is unknown', async () => {
    const blind = new ReviewPreviewService();
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
    await expect(read('../secret.txt')).rejects.toBeInstanceOf(NotFoundException);
    await expect(read('docs/../../secret.txt')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a symlink pointing outside the worktree', async () => {
    // The lexical containment check passes for this path; only resolving the
    // real path catches it.
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    await expect(read('leak.txt')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects paths into .git', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'config'), 'x');
    await expect(read('.git/config')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects the reserved bridge segment as an asset path', async () => {
    await expect(read('___ex/bridge.js')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves index.html for a directory', async () => {
    const asset = await read('docs');
    expect(asset.body.toString()).toContain('hi');
  });

  it('rejects an unknown preview id', async () => {
    await expect(service.readAsset('deadbeef', 'docs/index.html')).rejects.toBeInstanceOf(
      NotFoundException,
    );
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
    const session = await blind.createSession(root, 'javascript:alert(1)');
    const asset = await blind.readAsset(session.previewId, 'docs/index.html');

    expect(asset.contentSecurityPolicy).toContain("connect-src 'none'");
  });
});
