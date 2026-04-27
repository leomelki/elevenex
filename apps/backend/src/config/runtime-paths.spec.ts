import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { getBackendRuntimeRoot, getBackendVSCodeStaticPath } from './runtime-paths.js';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
}));

jest.mock('module', () => ({
  createRequire: jest.fn(),
}));

const mockExistsSync = jest.mocked(existsSync);
const mockCreateRequire = jest.mocked(createRequire);

describe('runtime-paths', () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    jest.resetAllMocks();
    process.cwd = jest.fn(() => '/repo');
    delete process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  });

  afterAll(() => {
    process.cwd = originalCwd;
  });

  it('prefers a staged vscode-web-dist directory when present', () => {
    mockExistsSync.mockImplementation((targetPath: any) => targetPath === '/repo/vscode-web-dist');

    expect(getBackendVSCodeStaticPath()).toBe('/repo/vscode-web-dist');
  });

  it('resolves vscode-web from the backend package context when the dist is installed elsewhere', () => {
    mockExistsSync.mockImplementation((targetPath: any) => {
      return targetPath === '/repo/package.json'
        || targetPath === '/repo/apps/backend/package.json'
        || targetPath === '/repo/node_modules/.pnpm/vscode-web@1.91.1/node_modules/vscode-web/dist';
    });

    mockCreateRequire.mockImplementation(((packageAnchor: string) => {
      return {
        resolve: (request: string) => {
          if (packageAnchor === '/repo/apps/backend/package.json' && request === 'vscode-web/package.json') {
            return '/repo/node_modules/.pnpm/vscode-web@1.91.1/node_modules/vscode-web/package.json';
          }

          throw new Error('module not found');
        },
      };
    }) as typeof createRequire);

    expect(getBackendVSCodeStaticPath()).toBe(
      join('/repo/node_modules/.pnpm/vscode-web@1.91.1/node_modules/vscode-web', 'dist'),
    );
  });

  it('prefers the repo root for runtime assets when launched from apps/backend in dev', () => {
    process.cwd = jest.fn(() => '/repo/apps/backend');

    mockExistsSync.mockImplementation((targetPath: any) => {
      return targetPath === '/repo/apps/frontend/proxy.conf.json'
        || targetPath === '/repo/apps/backend/package.json';
    });

    expect(getBackendRuntimeRoot()).toBe('/repo');
  });
});
