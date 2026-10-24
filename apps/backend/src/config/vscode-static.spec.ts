import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { vscodeStatic, resolveVSCodeAssetVersion } from './vscode-static';

describe('versioned precompressed VS Code assets', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vscode-assets-'));
    await mkdir(path.join(root, 'out/vs/workbench'), { recursive: true });
    for (const file of [
      'package.json',
      'out/vs/workbench/workbench.web.main.js',
      'out/vs/workbench/workbench.web.main.css',
    ])
      await writeFile(path.join(root, file), 'fixture');
    await writeFile(path.join(root, 'main.js.br'), 'compressed');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));
  it('changes the version when a runtime changes even with identical package metadata', async () => {
    const original = await resolveVSCodeAssetVersion(root);
    await writeFile(
      path.join(root, 'out/vs/workbench/workbench.web.main.js'),
      'upgraded',
    );
    expect(await resolveVSCodeAssetVersion(root)).not.toBe(original);
  });
  it.each([true, false])(
    'serves Brotli bytes with correct type, vary and immutable=%s',
    async (immutable) => {
      const response = {
        vary: jest.fn(),
        type: jest.fn(),
        setHeader: jest.fn(),
        sendFile: jest.fn(),
      };
      await vscodeStatic(root, immutable)(
        {
          method: 'GET',
          path: '/main.js',
          acceptsEncodings: () => 'br',
        } as any,
        response as any,
        jest.fn(),
      );
      expect(response.type).toHaveBeenCalledWith(path.join(root, 'main.js'));
      expect(response.vary).toHaveBeenCalledWith('Accept-Encoding');
      expect(response.setHeader).toHaveBeenCalledWith('Content-Encoding', 'br');
      expect(response.sendFile).toHaveBeenCalledWith(
        path.join(root, 'main.js.br'),
        expect.objectContaining({ immutable, maxAge: immutable ? '1y' : 0 }),
        expect.any(Function),
      );
    },
  );
  it('does not serve a compressed path outside the runtime root', async () => {
    const response = { vary: jest.fn(), sendFile: jest.fn() };
    const next = jest.fn();
    await vscodeStatic(root, true)(
      {
        method: 'GET',
        path: '/../secret.js',
        acceptsEncodings: () => 'br',
      } as any,
      response as any,
      next,
    );
    expect(response.sendFile).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
