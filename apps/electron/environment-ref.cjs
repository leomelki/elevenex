// An "environment reference" identifies which backend a window is bound to:
// the local embedded backend, the singleton WSL backend, or one saved SSH
// server. It is the join key between three layers that otherwise share no
// state — the renderer's onboarding snapshot, the window registry
// (window-manager.cjs) and the refcounted leases (connection-registry.cjs) —
// so it is defined once here rather than being re-derived in each of them.
//
// `label` is carried along purely for display (window titles, the Window menu).
// The main process never learns a saved server's name on its own: the list of
// servers lives in renderer localStorage, so whoever binds a window to an
// environment also supplies the label. It is deliberately excluded from
// identity comparisons.

// Sentinel "server id" for the singleton WSL backend connection. Mirrors
// WSL_SERVER_ID in main.cjs — negative so it never collides with a real saved
// SSH server's id (those are positive, Date.now()-based).
const WSL_SERVER_ID = -1;

const LOCAL_ENVIRONMENT_REF = Object.freeze({
  mode: 'local',
  serverId: null,
  label: 'Local',
});

function normalizeEnvironmentRef(value) {
  if (!value || typeof value !== 'object') {
    return { ...LOCAL_ENVIRONMENT_REF };
  }

  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : '';

  if (value.mode === 'wsl') {
    return {
      mode: 'wsl',
      serverId: WSL_SERVER_ID,
      label: label || 'WSL backend',
    };
  }

  if (value.mode === 'ssh') {
    const serverId = Number(value.serverId);
    // An ssh ref without a usable server id cannot address anything — fall
    // back to local rather than minting an unresolvable lease key.
    if (!Number.isInteger(serverId) || serverId <= 0) {
      return { ...LOCAL_ENVIRONMENT_REF };
    }
    return {
      mode: 'ssh',
      serverId,
      label: label || `Server ${serverId}`,
    };
  }

  return { mode: 'local', serverId: null, label: label || 'Local' };
}

// Stable identity of an environment, ignoring the display label. Matches the
// frontend's getBackendServerId() so both sides namespace state identically.
function environmentRefKey(envRef) {
  const normalized = normalizeEnvironmentRef(envRef);
  if (normalized.mode === 'wsl') {
    return 'wsl';
  }
  if (normalized.mode === 'ssh') {
    return `server-${normalized.serverId}`;
  }
  return 'local';
}

function environmentRefsEqual(left, right) {
  return environmentRefKey(left) === environmentRefKey(right);
}

module.exports = {
  LOCAL_ENVIRONMENT_REF,
  WSL_SERVER_ID,
  environmentRefKey,
  environmentRefsEqual,
  normalizeEnvironmentRef,
};
