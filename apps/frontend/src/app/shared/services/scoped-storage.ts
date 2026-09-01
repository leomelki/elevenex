import { getBackendServerId } from '@/shared/runtime/runtime-config';
import { getWindowId } from '@/shared/runtime/window-context';

/**
 * localStorage key scoping.
 *
 * Every desktop window shares one Chromium profile, so they also share one
 * localStorage. Two axes matter:
 *
 * - **per backend** (`@<serverId>`) — state that belongs to a workspace, such
 *   as which ports are forwarded for a project. Two windows on the same server
 *   should see the same thing; a window on another server should not.
 * - **per window** (`@<serverId>#win:<windowId>`) — working state such as open
 *   tabs and panel layout. Two windows are two independent workspaces, even on
 *   the same backend.
 *
 * The `#win:` separator is deliberate rather than a bare `#`: `pruneOrphanWindowScopes`
 * deletes keys, and it must be impossible for it to mistake an unrelated key
 * for an abandoned window scope.
 */
const WINDOW_SCOPE_SEPARATOR = '#win:';

function getStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Key shared by every window bound to the same backend. */
export function serverScopedKey(baseKey: string): string {
  return `${baseKey}@${getBackendServerId()}`;
}

/** Key private to this window on its current backend. */
export function windowScopedKey(baseKey: string): string {
  return `${serverScopedKey(baseKey)}${WINDOW_SCOPE_SEPARATOR}${getWindowId()}`;
}

export function parseWindowScopedKey(key: string): { windowId: string } | null {
  const separatorIndex = key.lastIndexOf(WINDOW_SCOPE_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const windowId = key.slice(separatorIndex + WINDOW_SCOPE_SEPARATOR.length);
  return windowId ? { windowId } : null;
}

/**
 * Moves a value from a key written by an older build to its scoped equivalent,
 * once. Never overwrites: if the scoped key already holds something, that value
 * is newer and wins.
 */
export function migrateScopedKey(legacyKey: string, scopedKey: string): void {
  const storage = getStorage();
  if (!storage || legacyKey === scopedKey) {
    return;
  }

  try {
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue === null) {
      return;
    }

    if (storage.getItem(scopedKey) === null) {
      storage.setItem(scopedKey, legacyValue);
    }
    storage.removeItem(legacyKey);
  } catch {
    // A full or unavailable storage must never break startup.
  }
}

/**
 * Window-scoped key, carrying over whatever an older build wrote the first time
 * it is asked for. `legacyKey` defaults to the unscoped base key, which is what
 * most callers used before windows existed; callers that were already
 * backend-scoped pass `serverScopedKey(base)`.
 */
export function migratedWindowScopedKey(baseKey: string, legacyKey: string = baseKey): string {
  const scoped = windowScopedKey(baseKey);
  migrateScopedKey(legacyKey, scoped);
  return scoped;
}

/**
 * Drops per-window state belonging to windows that no longer exist, so closing
 * windows over months does not grow localStorage without bound.
 *
 * Deliberately conservative: this deletes user state, so it only runs on a list
 * the main process vouches for. An empty or unverified list is treated as "we
 * do not know yet" and does nothing — in a browser, or before the window list
 * has arrived over IPC, wiping every scope would look like the app forgetting
 * all of the user's open tabs.
 */
export function pruneOrphanWindowScopes(
  liveWindowIds: readonly string[],
  options: { authoritative: boolean },
): number {
  const storage = getStorage();
  if (!storage || !options.authoritative || liveWindowIds.length === 0) {
    return 0;
  }

  // This window is live by definition. Belt and braces against a list that
  // somehow arrives without it — deleting our own open tabs and layout mid-
  // session would be the worst possible failure mode here.
  const live = new Set([...liveWindowIds, getWindowId()]);
  const orphaned: string[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const scope = key ? parseWindowScopedKey(key) : null;
      if (key && scope && !live.has(scope.windowId)) {
        orphaned.push(key);
      }
    }

    for (const key of orphaned) {
      storage.removeItem(key);
    }
  } catch {
    return 0;
  }

  return orphaned.length;
}
