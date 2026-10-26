import { homedir } from 'node:os';
import { join } from 'node:path';
import { BackendManager } from './manager';
import { readBackendRelease } from './release';
import { startBackend } from './process';
import { developmentBackend } from './development';

/** Keep mutable data separate from the legacy app and immutable version caches. */
export function createApplicationBackend(supervisor: string, isPackaged: boolean): BackendManager {
  return new BackendManager({
    root: join(homedir(), '.elevenex', 'desktop'),
    release: () => readBackendRelease(join(__dirname, '..')),
    ...developmentBackend(isPackaged),
    start: (installation, root, version, signal) => startBackend(installation, root, version, signal, supervisor),
  });
}
