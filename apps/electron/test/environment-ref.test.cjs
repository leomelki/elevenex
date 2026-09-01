const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  WSL_SERVER_ID,
  environmentRefKey,
  environmentRefsEqual,
  normalizeEnvironmentRef,
} = require('../environment-ref.cjs');

describe('normalizeEnvironmentRef', () => {
  it('defaults to local for missing or unknown input', () => {
    assert.deepEqual(normalizeEnvironmentRef(null), { mode: 'local', serverId: null, label: 'Local' });
    assert.deepEqual(normalizeEnvironmentRef({ mode: 'nope' }), { mode: 'local', serverId: null, label: 'Local' });
    assert.deepEqual(normalizeEnvironmentRef('local'), { mode: 'local', serverId: null, label: 'Local' });
  });

  it('pins the WSL sentinel id regardless of what the caller passes', () => {
    assert.deepEqual(normalizeEnvironmentRef({ mode: 'wsl', serverId: 42, label: 'WSL: Ubuntu' }), {
      mode: 'wsl',
      serverId: WSL_SERVER_ID,
      label: 'WSL: Ubuntu',
    });
  });

  it('keeps valid ssh refs and falls back to a label', () => {
    assert.deepEqual(normalizeEnvironmentRef({ mode: 'ssh', serverId: 7 }), {
      mode: 'ssh',
      serverId: 7,
      label: 'Server 7',
    });
  });

  it('degrades an ssh ref with an unusable server id to local', () => {
    // An unresolvable ssh ref would mint a lease key nothing can ever release.
    for (const serverId of [0, -1, 1.5, 'abc', null, undefined]) {
      assert.equal(normalizeEnvironmentRef({ mode: 'ssh', serverId }).mode, 'local');
    }
  });

  it('trims blank labels away instead of persisting whitespace', () => {
    assert.equal(normalizeEnvironmentRef({ mode: 'local', label: '   ' }).label, 'Local');
  });
});

describe('environmentRefKey', () => {
  it('matches the frontend getBackendServerId() namespace', () => {
    assert.equal(environmentRefKey({ mode: 'local' }), 'local');
    assert.equal(environmentRefKey({ mode: 'wsl' }), 'wsl');
    assert.equal(environmentRefKey({ mode: 'ssh', serverId: 12 }), 'server-12');
  });

  it('ignores the display label so a rename does not change identity', () => {
    assert.ok(environmentRefsEqual(
      { mode: 'ssh', serverId: 3, label: 'Prod' },
      { mode: 'ssh', serverId: 3, label: 'Production API' },
    ));
    assert.ok(!environmentRefsEqual({ mode: 'ssh', serverId: 3 }, { mode: 'ssh', serverId: 4 }));
  });
});
