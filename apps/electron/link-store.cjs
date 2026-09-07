// Persistence for remote-link credentials.
//
// Saved SSH servers live in renderer localStorage (see environment-ref.cjs), but
// pairing keys cannot: a pairing key is the whole credential for a backend that
// has no authentication of its own, so it stays in the main process, in a file
// only the user can read, and reaches the renderer only in redacted form.

'use strict';

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } = require('node:fs');
const path = require('node:path');

const FILE_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function decodeKey(value) {
  const buffer = Buffer.from(`${value || ''}`, 'base64');
  return buffer.length === 32 ? buffer : null;
}

function encodeKey(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function createLinkStore({ filePath, onError = () => {} }) {
  let state = { version: FILE_VERSION, sharing: null, links: [] };

  function load() {
    try {
      if (!existsSync(filePath)) {
        return;
      }
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.version !== FILE_VERSION) {
        return;
      }
      state = {
        version: FILE_VERSION,
        sharing: parsed.sharing || null,
        links: Array.isArray(parsed.links) ? parsed.links : [],
      };
    } catch (error) {
      // A damaged file must not stop the app from starting; the user can always
      // re-pair, which is cheaper than refusing to launch.
      onError(error);
    }
  }

  function save() {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(temporary, filePath);
      // rename preserves the temp file's mode, but an pre-existing file may have
      // been created before this was enforced.
      chmodSync(filePath, 0o600);
    } catch (error) {
      onError(error);
    }
  }

  load();

  // --- sharing (this machine offering its backend) ------------------------

  function getSharing() {
    const sharing = state.sharing;
    if (!sharing) {
      return null;
    }
    const pairingKey = decodeKey(sharing.pairingKey);
    if (!pairingKey) {
      return null;
    }
    return {
      version: 1,
      transport: sharing.transport,
      endpoint: sharing.endpoint,
      pairId: sharing.pairId,
      pairingKey,
      label: sharing.label || '',
      enabled: Boolean(sharing.enabled),
      createdAt: sharing.createdAt,
    };
  }

  function setSharing(pairing, { enabled }) {
    state.sharing = {
      transport: pairing.transport,
      endpoint: pairing.endpoint,
      pairId: pairing.pairId,
      pairingKey: encodeKey(pairing.pairingKey),
      label: pairing.label || '',
      enabled: Boolean(enabled),
      createdAt: state.sharing?.createdAt || nowIso(),
    };
    save();
    return getSharing();
  }

  function setSharingEnabled(enabled) {
    if (!state.sharing) {
      return null;
    }
    state.sharing.enabled = Boolean(enabled);
    save();
    return getSharing();
  }

  function clearSharing() {
    state.sharing = null;
    save();
  }

  // --- saved links (backends this machine can connect to) -----------------

  function listLinks() {
    return state.links
      .map((link) => {
        const pairingKey = decodeKey(link.pairingKey);
        if (!pairingKey) {
          return null;
        }
        return {
          id: link.id,
          name: link.name,
          version: 1,
          transport: link.transport,
          endpoint: link.endpoint,
          pairId: link.pairId,
          pairingKey,
          createdAt: link.createdAt,
          lastConnectedAt: link.lastConnectedAt || '',
        };
      })
      .filter(Boolean);
  }

  function getLink(id) {
    return listLinks().find((link) => link.id === Number(id)) || null;
  }

  function addLink({ name, pairing }) {
    // Ids are Date.now()-based and positive, matching the saved-SSH-server
    // convention so environment keys never collide across modes.
    let id = Date.now();
    while (state.links.some((link) => link.id === id)) {
      id += 1;
    }

    state.links.push({
      id,
      name: `${name || pairing.label || 'Shared device'}`.slice(0, 64),
      transport: pairing.transport,
      endpoint: pairing.endpoint,
      pairId: pairing.pairId,
      pairingKey: encodeKey(pairing.pairingKey),
      createdAt: nowIso(),
      lastConnectedAt: '',
    });
    save();
    return getLink(id);
  }

  function renameLink(id, name) {
    const link = state.links.find((entry) => entry.id === Number(id));
    if (!link) {
      return null;
    }
    link.name = `${name || ''}`.slice(0, 64) || link.name;
    save();
    return getLink(id);
  }

  function removeLink(id) {
    const before = state.links.length;
    state.links = state.links.filter((link) => link.id !== Number(id));
    if (state.links.length !== before) {
      save();
      return true;
    }
    return false;
  }

  function markConnected(id) {
    const link = state.links.find((entry) => entry.id === Number(id));
    if (!link) {
      return;
    }
    link.lastConnectedAt = nowIso();
    save();
  }

  return {
    addLink,
    clearSharing,
    getLink,
    getSharing,
    listLinks,
    markConnected,
    removeLink,
    renameLink,
    setSharing,
    setSharingEnabled,
  };
}

module.exports = { createLinkStore };
