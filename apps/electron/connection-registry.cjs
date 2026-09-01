// Refcounted leases between windows and backend environments.
//
// With multiple windows open, an environment is no longer owned by "the" window:
// two windows can sit on the same SSH server (sharing one `ssh -L` tunnel), and
// every local window shares the single embedded backend. So teardown can only
// happen when the *last* holder lets go — a plain "window closed, stop the
// tunnel" would cut the other window's connection.
//
// The registry owns that bookkeeping and nothing else: it never spawns or kills
// anything itself, it just tells the caller when an environment gained its first
// holder (`onAcquire`) or lost its last (`onRelease`).
//
// It also serializes the expensive part. Restoring three local windows must not
// race three `startEmbeddedBackend()` calls, and two windows opening the same
// never-installed SSH server must share one `ensureRemoteServerReady()` run
// (AGENTS.md: "use async flows with in-flight request coalescing"). `run()`
// gives every caller the same in-flight promise per environment key.

const { environmentRefKey, normalizeEnvironmentRef } = require('./environment-ref.cjs');

function createConnectionRegistry(options = {}) {
  const onAcquire = typeof options.onAcquire === 'function' ? options.onAcquire : () => {};
  const onRelease = typeof options.onRelease === 'function' ? options.onRelease : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  // key -> { envRef, windowIds: Set<string> }
  const leases = new Map();
  // windowId -> key
  const windowEnvironments = new Map();
  // key -> Promise
  const inFlight = new Map();

  function notify(hook, envRef) {
    try {
      const result = hook(envRef);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => onError(error, envRef));
      }
      return result;
    } catch (error) {
      onError(error, envRef);
      return undefined;
    }
  }

  function acquire(windowId, envRefInput) {
    const envRef = normalizeEnvironmentRef(envRefInput);
    const key = environmentRefKey(envRef);
    const previousKey = windowEnvironments.get(windowId);
    if (previousKey === key) {
      // Same environment, possibly a new label — refresh it so the window title
      // and Window menu follow a server rename without churning the lease.
      const lease = leases.get(key);
      if (lease) {
        lease.envRef = envRef;
      }
      return { key, isFirstHolder: false };
    }

    let lease = leases.get(key);
    const isFirstHolder = !lease || lease.windowIds.size === 0;
    if (!lease) {
      lease = { envRef, windowIds: new Set() };
      leases.set(key, lease);
    }
    lease.envRef = envRef;
    lease.windowIds.add(windowId);
    windowEnvironments.set(windowId, key);

    if (isFirstHolder) {
      notify(onAcquire, envRef);
    }

    return { key, isFirstHolder };
  }

  function releaseKey(windowId, key) {
    const lease = leases.get(key);
    if (!lease) {
      return { key, isLastHolder: false };
    }

    lease.windowIds.delete(windowId);
    if (lease.windowIds.size > 0) {
      return { key, isLastHolder: false };
    }

    leases.delete(key);
    notify(onRelease, lease.envRef);
    return { key, isLastHolder: true };
  }

  function release(windowId, envRefInput) {
    const key = environmentRefKey(envRefInput);
    if (windowEnvironments.get(windowId) === key) {
      windowEnvironments.delete(windowId);
    }
    return releaseKey(windowId, key);
  }

  // A window closed (or crashed): drop whatever it was holding, whatever that
  // was. Callers should never have to remember a closing window's environment.
  function releaseAll(windowId) {
    const key = windowEnvironments.get(windowId);
    if (!key) {
      return null;
    }
    windowEnvironments.delete(windowId);
    return releaseKey(windowId, key);
  }

  // A window switched environments at runtime (the environment switcher).
  // Acquire before releasing so a shared resource is never briefly at zero
  // holders, which would tear it down and immediately rebuild it.
  function setEnvironment(windowId, envRefInput) {
    const previousKey = windowEnvironments.get(windowId);
    const acquired = acquire(windowId, envRefInput);
    if (previousKey && previousKey !== acquired.key) {
      releaseKey(windowId, previousKey);
    }
    return acquired;
  }

  function environmentOf(windowId) {
    const key = windowEnvironments.get(windowId);
    if (!key) {
      return null;
    }
    return leases.get(key)?.envRef ?? null;
  }

  function holders(envRefInput) {
    const lease = leases.get(environmentRefKey(envRefInput));
    return lease ? [...lease.windowIds] : [];
  }

  function environments() {
    return [...leases.entries()].map(([key, lease]) => ({
      key,
      envRef: lease.envRef,
      windowIds: [...lease.windowIds],
    }));
  }

  // Coalesce expensive per-environment work. Concurrent callers for the same
  // key share one promise; the entry is dropped once settled so a later retry
  // (eg. after a failed remote install) starts fresh rather than replaying the
  // rejection forever.
  function run(envRefInput, factory) {
    const key = environmentRefKey(envRefInput);
    const existing = inFlight.get(key);
    if (existing) {
      return existing;
    }

    let promise;
    try {
      promise = Promise.resolve(factory());
    } catch (error) {
      return Promise.reject(error);
    }

    const tracked = promise.finally(() => {
      if (inFlight.get(key) === tracked) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, tracked);
    return tracked;
  }

  function isRunning(envRefInput) {
    return inFlight.has(environmentRefKey(envRefInput));
  }

  return {
    acquire,
    environmentOf,
    environments,
    holders,
    isRunning,
    release,
    releaseAll,
    run,
    setEnvironment,
  };
}

module.exports = { createConnectionRegistry };
