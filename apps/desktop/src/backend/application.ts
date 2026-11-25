import { join } from 'node:path';
import { BackendManager } from './manager';
import { readBackendRelease } from './release';
import { startBackend } from './process';
import { developmentBackend } from './development';

/** Keep mutable data separate from the legacy app and immutable version caches. */
export function createApplicationBackend(supervisor: string, isPackaged: boolean, root: string): BackendManager {
  return new BackendManager({
    root,
    release: () => readBackendRelease(join(__dirname, '..')),
    ...developmentBackend(isPackaged),
    start: (installation, root, version, signal) => startBackend(installation, root, version, signal, supervisor),
  });
}
