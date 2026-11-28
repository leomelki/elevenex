import { existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import {
  getBackendRuntimeRoot,
} from './runtime-paths.js';

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
  const originalRuntimeRoot = process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  const workbench = (root: string) =>
    join(root, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html');

  beforeEach(() => {
    jest.resetAllMocks();
    process.cwd = jest.fn(() => '/repo');
    delete process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
  });

  afterAll(() => {
    process.cwd = originalCwd;
    if (originalRuntimeRoot === undefined)
      delete process.env.ELEVENEX_BACKEND_RUNTIME_ROOT;
    else process.env.ELEVENEX_BACKEND_RUNTIME_ROOT = originalRuntimeRoot;
  });

  it('prefers the repo root for runtime assets when launched from apps/backend in dev', () => {
    process.cwd = jest.fn(() => '/repo/apps/backend');

    mockExistsSync.mockImplementation((targetPath: any) => {
      return (
        targetPath === '/repo/apps/frontend/proxy.conf.json' ||
        targetPath === '/repo/apps/backend/package.json'
      );
    });

    expect(getBackendRuntimeRoot()).toBe('/repo');
  });
});
