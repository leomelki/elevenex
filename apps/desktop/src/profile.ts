import { homedir } from 'node:os';
import { join } from 'node:path';

/** Mutable state owned by one kind of build. */
export interface DesktopProfile {
  /** Electron profile directory under the platform application-data directory. */
  readonly userDataName: string;
  /** Local backend data and runtimes, plus remote archive caches. */
  readonly root: string;
}

/**
 * Packaged and unpackaged builds never share mutable state: a branch build can
 * save settings or migrate a database that an installed release cannot read.
 * The Electron profile stays under appData so test launchers that redirect
 * appData keep isolating native and browser state.
 */
export function desktopProfile(isPackaged: boolean, home = homedir()): DesktopProfile {
  return isPackaged
    ? { userDataName: 'Elevenex Desktop', root: join(home, '.elevenex', 'desktop') }
    : { userDataName: 'Elevenex Desktop Development', root: join(home, '.elevenex', 'desktop-dev') };
}
