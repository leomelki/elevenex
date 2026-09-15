const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  canUseMacTrustStoreFallback,
  parseMacSignatureDetails,
} = require('../app-updater.cjs');

describe('macOS update signature fallback', () => {
  const current = {
    identifier: 'fr.leomelki.elevenex',
    teamIdentifier: '8CL6W3N2X9',
    notarized: true,
  };

  it('parses the signed identity printed by codesign', () => {
    assert.deepEqual(parseMacSignatureDetails(`Executable=/Applications/Elevenex.app/Contents/MacOS/Elevenex
Identifier=fr.leomelki.elevenex
Authority=(unavailable)
Notarization Ticket=stapled
TeamIdentifier=8CL6W3N2X9
`), current);
  });

  it('allows the same notarized app identity when macOS trust verification is unavailable', () => {
    assert.equal(canUseMacTrustStoreFallback(current, { ...current }), true);
  });

  it('rejects a different bundle identifier or signing team', () => {
    assert.equal(canUseMacTrustStoreFallback(current, {
      ...current,
      identifier: 'com.example.lookalike',
    }), false);
    assert.equal(canUseMacTrustStoreFallback(current, {
      ...current,
      teamIdentifier: 'ATTACKER123',
    }), false);
  });

  it('rejects an app without a stapled notarization ticket or a known signing team', () => {
    assert.equal(canUseMacTrustStoreFallback(current, { ...current, notarized: false }), false);
    assert.equal(canUseMacTrustStoreFallback(
      { ...current, teamIdentifier: null },
      { ...current },
    ), false);
  });
});
