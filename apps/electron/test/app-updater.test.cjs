const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  canUseMacTrustStoreFallback,
  parseHdiutilMountPoint,
  parseMacSignatureDetails,
} = require('../app-updater.cjs');

describe('macOS disk image mount parsing', () => {
  it('accepts an hdiutil mount point printed through the canonical path', (context) => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-updater-test-'));
    context.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

    const canonicalMountBase = path.join(temporaryDirectory, 'canonical');
    const aliasedMountBase = path.join(temporaryDirectory, 'alias');
    const mountPoint = path.join(canonicalMountBase, 'dmg.example');
    mkdirSync(mountPoint, { recursive: true });
    symlinkSync(canonicalMountBase, aliasedMountBase, 'dir');

    assert.equal(
      parseHdiutilMountPoint(
        `/dev/disk4s1\tApple_HFS\t${mountPoint}\n`,
        aliasedMountBase,
      ),
      realpathSync(mountPoint),
    );
  });

  it('ignores paths outside the requested mount directory', () => {
    assert.equal(
      parseHdiutilMountPoint('/dev/disk4s1\tApple_HFS\t/Volumes/Elevenex\n', os.tmpdir()),
      null,
    );
  });
});

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
